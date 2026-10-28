import { Parser } from 'htmlparser2'

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
  item?: RSSItem | RSSItem[]
  [key: string]: unknown
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

function parseRssWithSax(xmlText: string, cutoffTime: number): { channel: RSSChannel; items: RSSItem[] } {
  const channel: RSSChannel = { title: '', link: '', description: '' }
  const items: RSSItem[] = []

  let inChannel = false
  let inItem = false
  let textBuf = ''
  let currentItem: RSSItem | null = null
  let stopped = false

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (stopped) return
        textBuf = ''

        if (name === 'channel') {
          inChannel = true
        } else if (name === 'item') {
          inItem = true
          currentItem = { title: '', link: '', pubDate: '' }
        } else if (inItem && name === 'enclosure') {
          if (currentItem) {
            currentItem.enclosure = {
              '@_url': attribs.url,
              '@_type': attribs.type,
              '@_length': attribs.length,
            }
          }
        }
      },
      ontext(text) {
        if (stopped) return
        textBuf += text
      },
      onclosetag(name) {
        if (stopped) return

        if (inItem) {
          if (name === 'item') {
            inItem = false
            if (currentItem) {
              const pubTime = new Date(currentItem.pubDate || '').getTime()
              // DMHY 条目按时间降序排列，遇到超过时间窗口即直接终止解析
              if (!isNaN(pubTime) && pubTime < cutoffTime) {
                stopped = true
                parser.pause()
                return
              }
              items.push(currentItem)
            }
            currentItem = null
          } else if (currentItem) {
            if (name === 'title') currentItem.title = textBuf.trim()
            else if (name === 'link') currentItem.link = textBuf.trim()
            else if (name === 'pubDate') currentItem.pubDate = textBuf.trim()
            else if (name === 'description') currentItem.description = textBuf.trim()
            else if (name === 'author') currentItem.author = textBuf.trim()
            else if (name === 'guid') currentItem.guid = textBuf.trim()
          }
        } else if (inChannel) {
          if (name === 'title') channel.title = textBuf.trim()
          else if (name === 'link') channel.link = textBuf.trim()
          else if (name === 'description') channel.description = textBuf.trim()
          else if (name === 'channel') inChannel = false
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )

  const chunkSize = 8192
  for (let i = 0; i < xmlText.length; i += chunkSize) {
    if (stopped) break
    parser.write(xmlText.slice(i, i + chunkSize))
  }
  parser.end()

  return { channel, items }
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

    // 2. 流式 SAX 解析 RSS（并在到达时间窗口时即时退出）
    const cutoffTime = Date.now() - TIME_WINDOW_HOURS * 60 * 60 * 1000
    const { channel, items: recentItems } = parseRssWithSax(rssResult.text, cutoffTime)

    // 3. 并发获取文件名，只保留成功获取的 item
    const results = await Promise.all(
      recentItems.map(async (item) => {
        const filename = await fetchFilenameWithCache(item.link, cache, ctx)
        return filename ? { ...item, title: filename } : null
      }),
    )
    const processedItems = results.filter((item): item is RSSItem => item !== null)

    // 4. 生成 XML（只包含成功解析的 item）
    const outputXml = buildRssXml(channel, processedItems, request.url)

    return new Response(outputXml, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    })
  },
} satisfies ExportedHandler

// 爬虫逻辑（使用 HTMLRewriter 流式解析）
async function fetchFilenameFromPage(url: string): Promise<{ filename: string | null; skipMarker: SkipReason | null }> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!resp.ok) return { filename: null, skipMarker: SkipReason.HttpError }

  let listCount = 0
  let isTargetLi = false
  let rawText = ''

  const rewriter = new HTMLRewriter()
    .on('.file_list li', {
      element() {
        listCount++
        if (listCount === 1) isTargetLi = true
      },
      text(text) {
        if (isTargetLi) {
          rawText += text.text
        }
      },
    })
    .on('.file_list li .bt_file_size', {
      element(el) {
        el.remove()
      },
    })

  await rewriter.transform(resp).text()

  if (listCount === 0) return { filename: null, skipMarker: SkipReason.NoFileList }
  if (listCount !== 1) return { filename: null, skipMarker: SkipReason.NotSingleFile }

  const text = rawText.trim()
  const filename = text.split('/').pop()?.trim() || ''

  return { filename: filename || null, skipMarker: filename ? null : SkipReason.NoFileList }
}
