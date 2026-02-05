import { XMLParser } from 'fast-xml-parser'
import { parseHTML } from 'linkedom'

// ================= 配置区域 =================
const RSS_URL = 'https://share.dmhy.org/topics/rss/rss.xml'
const TIME_WINDOW_HOURS = 2 // 只处理最近 2 小时的种子
const CACHE_TIME = 60 * 60 * 24 * 7 // 文件名缓存 7 天 (秒)
const FAIL_CACHE_TIME = 60 * 60 // 失败缓存 1 小时 (秒)
const RSS_CACHE_TIME = 60 * 30 // RSS 缓存 30 分钟 (秒)
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const enum SkipReason {
  NotSingleFile = 'SKIP_NOT_SINGLE',
  NoFileList = 'SKIP_NO_FILE_LIST',
  HttpError = 'SKIP_HTTP_ERROR',
}

interface RSSItem {
  title: string
  link: string
  pubDate: string
  description?: string
  author?: string
  guid?: string
  enclosure?: {
    '@_url'?: string
    '@_type'?: string
    '@_length'?: string
  }
  [key: string]: unknown
}

interface RSSChannel {
  title?: string
  link?: string
  description?: string
  item: RSSItem | RSSItem[]
  [key: string]: unknown
}

interface RSSObject {
  rss: {
    channel: RSSChannel
    [key: string]: unknown
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildRssXml(channel: RSSChannel, items: RSSItem[], selfUrl: string): string {
  const channelTitle = channel.title || 'DMHY RSS'
  const channelLink = channel.link || 'https://share.dmhy.org'
  const channelDescription = channel.description || 'DMHY Filename RSS'
  const lastBuildDate = items[0]?.pubDate || new Date().toUTCString()

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:content="http://purl.org/rss/1.0/modules/content/"
    xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
    <channel>
        <title><![CDATA[${channelTitle}]]></title>
        <description><![CDATA[${channelDescription}]]></description>
        <link>${escapeXml(channelLink)}</link>
        <generator>DMHY-Filename-RSS</generator>
        <lastBuildDate>${lastBuildDate}</lastBuildDate>
        <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
        <ttl>${RSS_CACHE_TIME / 60}</ttl>
`

  for (const item of items) {
    const enclosureUrl = item.enclosure?.['@_url'] || ''
    const enclosureType = item.enclosure?.['@_type'] || 'application/x-bittorrent'
    const enclosureLength = item.enclosure?.['@_length'] || '1'

    xml += `        <item>
            <title><![CDATA[${item.title}]]></title>
            <description><![CDATA[${item.description || ''}]]></description>
            <link>${escapeXml(item.link)}</link>
            <guid isPermaLink="true">${escapeXml(item.link)}</guid>
            <pubDate>${item.pubDate}</pubDate>
`
    if (enclosureUrl) {
      xml += `            <enclosure url="${escapeXml(enclosureUrl)}" length="${enclosureLength}" type="${escapeXml(enclosureType)}" />
`
    }
    xml += `        </item>
`
  }

  xml += `    </channel>
</rss>`

  return xml
}

async function fetchRssText(cache: Cache, ctx: ExecutionContext): Promise<{ text: string } | { error: Response }> {
  const cacheKey = new Request(RSS_URL, { method: 'GET' })

  const cached = await cache.match(cacheKey)
  if (cached) {
    return { text: await cached.text() }
  }

  const response = await fetch(RSS_URL, {
    headers: { 'User-Agent': USER_AGENT },
  })

  if (!response.ok) {
    return { error: new Response('DMHY Unreachable', { status: 502 }) }
  }

  const text = await response.text()

  const toCache = new Response(text, {
    headers: {
      'Cache-Control': `public, max-age=${RSS_CACHE_TIME}`,
      'Content-Type': 'application/xml',
    },
  })
  ctx.waitUntil(cache.put(cacheKey, toCache))

  return { text }
}

async function fetchFilenameWithCache(link: string, cache: Cache, ctx: ExecutionContext): Promise<string | null> {
  const normalizedLink = link.replace(/^http:/, 'https:')
  const cacheKey = new Request(normalizedLink, { method: 'GET' })

  const cached = await cache.match(cacheKey)
  if (cached) {
    const filename = await cached.text()
    if (
      filename === SkipReason.NotSingleFile ||
      filename === SkipReason.NoFileList ||
      filename === SkipReason.HttpError
    ) {
      return null
    }
    return filename
  }

  let filename: string | null
  let skipMarker: SkipReason | null = null
  try {
    const result = await fetchFilenameFromPage(normalizedLink)
    filename = result.filename
    skipMarker = result.skipMarker
  } catch (e) {
    console.error(`Error scraping ${link}:`, e)
    filename = null
    skipMarker = SkipReason.HttpError
  }

  // 记录未命中缓存的结果
  console.log(`[FETCH] ${normalizedLink} -> ${filename || skipMarker}`)

  const cacheBody = filename || skipMarker || SkipReason.HttpError
  // 只有 HTTP 错误或找不到文件列表才用短缓存，多文件种子用正常缓存
  const isTemporaryFailure = skipMarker === SkipReason.HttpError || skipMarker === SkipReason.NoFileList
  const maxAge = isTemporaryFailure ? FAIL_CACHE_TIME : CACHE_TIME
  const toCache = new Response(cacheBody, {
    headers: {
      'Cache-Control': `public, max-age=${maxAge}`,
      'Content-Type': 'text/plain',
    },
  })
  ctx.waitUntil(cache.put(cacheKey, toCache))

  return filename
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const cache = caches.default

    // 1. 获取 RSS
    const rssResult = await fetchRssText(cache, ctx)
    if ('error' in rssResult) return rssResult.error

    // 2. 解析 XML
    const parser = new XMLParser({
      ignoreAttributes: false,
      preserveOrder: false,
      parseTagValue: true,
      trimValues: true,
    })
    const rssObj = parser.parse(rssResult.text) as RSSObject

    let items = rssObj.rss.channel.item
    if (!Array.isArray(items)) items = [items]

    // 3. 时间过滤
    const cutoffTime = Date.now() - TIME_WINDOW_HOURS * 60 * 60 * 1000
    const recentItems = items.filter((item) => new Date(item.pubDate).getTime() >= cutoffTime)

    // 4. 并发获取文件名，只保留成功获取的 item
    const results = await Promise.all(
      recentItems.map(async (item) => {
        const filename = await fetchFilenameWithCache(item.link, cache, ctx)
        return filename ? { ...item, title: filename } : null
      }),
    )
    const processedItems = results.filter((item): item is RSSItem => item !== null)

    // 5. 生成 XML（只包含成功解析的 item）
    const outputXml = buildRssXml(rssObj.rss.channel, processedItems, request.url)

    return new Response(outputXml, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    })
  },
} satisfies ExportedHandler

// 爬虫逻辑
async function fetchFilenameFromPage(url: string): Promise<{ filename: string | null; skipMarker: SkipReason | null }> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!resp.ok) return { filename: null, skipMarker: SkipReason.HttpError }
  const html = await resp.text()

  const { document } = parseHTML(html)

  // 找到 file_list 容器
  const fileList = document.querySelector('.file_list')
  if (!fileList) return { filename: null, skipMarker: SkipReason.NoFileList }

  // 获取所有 li 元素
  const listItems = fileList.querySelectorAll('li')

  // 只处理单文件种子
  if (listItems.length !== 1) return { filename: null, skipMarker: SkipReason.NotSingleFile }

  const li = listItems[0]
  // 获取 li 的文本内容，排除 span（文件大小）
  const sizeSpan = li.querySelector('.bt_file_size')
  if (sizeSpan) sizeSpan.remove()

  const text = li.textContent?.trim() || ''
  // 取路径的最后一部分作为文件名
  const filename = text.split('/').pop()?.trim() || ''

  return { filename: filename || null, skipMarker: filename ? null : SkipReason.NoFileList }
}
