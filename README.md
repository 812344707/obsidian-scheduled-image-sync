# 图床定时同步

Obsidian 图片管理插件：定时上传本地图片到自选的 S3 兼容图床，原位替换链接，并检索、勾选清理未引用图片。

基于 [S3 Image Sync 1.0.10](https://github.com/JongChoiYip/s3-image-sync) 的 MIT 修改版。当前版本：**1.0.10-local.3**；插件 ID：`s3-image-sync-local`。

## 功能

- 可设扫描间隔，支持 1 至 10080 分钟，默认 30 分钟。定时上传默认关闭，自动上传保留本地原图。
- 可配置 Cloudflare R2、AWS S3、MinIO 或其他 S3 兼容服务的端点、存储桶与公开访问地址。
- 上传笔记里的本地图片，在原位置替换为远程链接。
- 全库检索未引用图片，支持文件名/路径筛选、复选框和删除预览。
- 可选仅删除本地，或本地＋图床删除。本地移入库内 `.trash`；图床仍被引用、或缺少可核验上传记录时禁止删除远端对象。

## 下载与安装

从 [1.0.10-local.3 版本页面](https://github.com/812344707/obsidian-scheduled-image-sync/releases/tag/1.0.10-local.3) 下载 ZIP 安装包，解压后将 `s3-image-sync-local` 文件夹放到库的 `.obsidian/plugins/` 中，在第三方插件设置中启用。

升级时先停用插件，只覆盖 `main.js`、`manifest.json`、`styles.css`，**保留原有 `data.json`**，避免丢失图床配置和上传记录。

- [完整安装与配置说明](s3-image-sync/README.md)
- [验证情况与适用边界](docs/validation.md)

## 使用边界

定时同步仅在电脑上的 Obsidian 运行期间执行。普通 HTTP 上传接口、PicGo 和 PicList 尚未支持。未引用图片清理需手动发起，不会按计划自动删除。

图床清理只针对本插件有明确上传记录的对象，不遍历整个存储桶；旧版缺少记录的图片仅支持本地删除。检查范围是当前库，不保证识别其他库、网站或不支持格式中的引用。图床删除无法通过插件撤销。

28 项自动化测试通过，并在 Obsidian 1.13.7 的隔离库完成界面与本地回收站验证。上传、远端删除已使用本机 HTTP 服务测试；真实图床账号与手机端尚未实机验证。

## 开发

源码位于 `s3-image-sync/`。使用 Node.js 22：

```sh
cd s3-image-sync
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

## 来源与许可证

保留 [上游原说明](s3-image-sync/UPSTREAM-README.md) 和 [MIT 许可证](LICENSE)。本项目为独立修改版，并非上游官方发布。
