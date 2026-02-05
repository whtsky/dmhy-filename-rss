# DMHY Filename RSS

Cloudflare Worker，将动漫花园 RSS 的标题替换为种子内的真实文件名。

https://dmhy-filename-rss.whtsky.me

> 🤖 本项目由 AI 纯 vibe coding 完成

## 示例

```diff
- [LoliHouse] 【我推的孩子】 第三季 / Oshi no Ko S3 - 04 [WebRip 1080p HEVC-10bit AAC][简繁内封字幕]
+ [LoliHouse] Oshi no Ko S3 - 04 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv
```

## 为什么？

Sonarr 经常因为字幕组标题格式复杂而无法正确解析剧集信息。种子内的文件名通常更规范，用它替换标题能显著提高解析成功率。
