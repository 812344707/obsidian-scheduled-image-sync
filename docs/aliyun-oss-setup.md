# 阿里云 OSS 图床配置过程

核对日期：2026-09-05。适用项目：图床定时同步。

## 适用版本

`1.0.10-local.4` 新增「阿里云 OSS」服务商，插件直接调用 OSS 的 S3 兼容接口完成上传、连接测试和云端删除，无需安装或运行 PicGo。旧版 `.3` 未适配 OSS 寻址方式，需升级。

插件根据地域自动生成端点，采用 Bucket 放在域名中的虚拟托管寻址方式。不要用「自定义 S3」代替「阿里云 OSS」。[阿里云 S3 兼容性说明](https://help.aliyun.com/zh/oss/developer-reference/compatibility-with-amazon-s3)

当前支持外网地域端点；内网、传输加速、STS 临时凭据和私有图片鉴权显示未包含在本版中。已通过自动化请求与签名验证，尚未使用真实 OSS 账号联调；连接测试通过也不代表上传、删除和公开显示均已验证。

## 1. 创建专用 Bucket

登录阿里云控制台，搜索「对象存储 OSS」，进入 Bucket 列表并创建 Bucket。以下是示例配置，名称需要换成你实际创建且可用的名称。

| 项目 | 示例 |
| --- | --- |
| Bucket 名称 | `obsidian-images-example` |
| 地域 | 华东 1（杭州） |
| 地域 ID | `cn-hangzhou` |
| 存储类型 | 标准存储 |
| 图片目录 | `images/` |

建议先保持私有，待确认图片可以公开时再设置公开读取。使用专用 Bucket，避免把私人文件与可公开图片放在一起。

本教程中的杭州仅用于说明字段对应关系，不需要迁移你已有的 Bucket。标准存储适合直接读取的图片场景。[OSS 产品说明](https://www.alibabacloud.com/help/en/oss/user-guide/what-is-oss)

## 2. 确定图片是否公开

插件把不含临时签名的图片地址写入笔记；要让这些链接长期直接显示图片，访问地址必须允许无需登录读取。

如果这个 Bucket 只放可公开的图片，可以在 Bucket 权限设置中选择「公共读」。不要选择「公共读写」。**公共读意味着任何获得图片链接的人都能读取图片；不适合患者资料、证件或其他私人笔记图片。**

如果控制台提示「阻止公共访问」，应检查 Bucket 和 OSS 全局两个层级；上层阻止会覆盖下层设置。不要为了一个图床直接放开其他私人 Bucket 的保护。若已有全局保护，应先评估其他 Bucket 的 ACL/Policy，或采用单独账号隔离公开图片。

若图片需要私密访问，请保留私有；当前插件没有长期私有链接的鉴权和续签方案，此教程的公共图床模式不适用。[OSS 阻止公共访问](https://help.aliyun.com/zh/oss/user-guide/block-public-access/)

## 3. 创建插件专用 RAM 用户和 AccessKey

在阿里云「访问控制 RAM」中创建专用用户，例如 `obsidian-image-sync`，为该用户创建 AccessKey。保存 AccessKey ID 与 AccessKey Secret，Secret 通常只显示一次。插件使用这组 RAM 用户凭据，不使用主账号 AccessKey。[创建 AccessKey](https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair)

在 RAM 的权限策略中创建自定义策略，将下面示例中的 Bucket 名替换为你的真实名称，然后授权给这个 RAM 用户：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:ListObjects"],
      "Resource": ["acs:oss:*:*:obsidian-images-example"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject"],
      "Resource": ["acs:oss:*:*:obsidian-images-example/images/*"]
    }
  ]
}
```

这是针对本插件用途编写的授权示例：列举权限用于连接测试；上传、读取和删除仅限 `images/` 目录。若不使用「本地＋图床删除」，可以移除 `oss:DeleteObject`，届时图床删除会因权限不足失败。修改上传目录时也要同步修改策略中的对象路径。

这是 **RAM 用户策略**，不要把它当作匿名公开读取的 Bucket Policy；两者用途不同。策略结构和资源写法参见 [OSS 授权语法](https://help.aliyun.com/zh/oss/user-guide/authorization-syntax-and-elements)。不要将真实密钥填入文档、截图或 GitHub。

## 4. 设置图片访问域名

准备一个图片子域名，例如 `img.example.com`，实际使用时替换成自己的域名。

1. 进入目标 Bucket 的「Bucket 配置 → 域名管理」，绑定图片子域名。
2. 根据控制台提示验证域名所有权。
3. 在域名的 DNS 服务商处添加 CNAME：主机记录为 `img`，记录值使用 OSS 控制台给出的 CNAME 目标，不带 `https://` 和文件路径。
4. 为此域名配置 HTTPS 证书。
5. 等待解析生效后，验证图片能通过 `https://img.example.com/images/test.png` 访问。

杭州属于中国内地节点，绑定域名须完成 ICP 备案；阿里云文档对非中国内地节点另有说明。OSS 默认域名可能触发附件下载，因此长期图床访问建议使用已绑定的自定义域名。[OSS 自定义域名配置](https://help.aliyun.com/zh/oss/user-guide/access-buckets-via-custom-domain-names)

这一步不要求先购买 CDN；先把直接访问和 HTTPS 验证通过。

## 5. 先在 OSS 控制台验证一张图片

先用不含私人信息的小 PNG 图片测试：

1. 在 Bucket 文件列表中创建 `images/` 目录，上传 `test.png`。
2. 确认对象没有单独设置为私有，其权限继承已配置的公共读权限。
3. 在浏览器无痕窗口打开 `https://img.example.com/images/test.png`。
4. 在 Obsidian 测试笔记里插入 `![OSS测试](https://img.example.com/images/test.png)`，确认能显示。

浏览器不登录也能访问、Obsidian 能显示，才说明公开读取链路基本可用。这一步通过控制台上传，**不能证明插件的 RAM 凭据和自动上传已经可用**。

## 6. 在插件中配置

安装 `.4` 版后，进入 Obsidian「设置 → 图床定时同步」，按下表填写。

| 信息 | 杭州示例 |
| --- | --- |
| 存储服务商 | **阿里云 OSS** |
| 端点 URL | 自动生成，无需填写 |
| Region | `cn-hangzhou` |
| Bucket | `obsidian-images-example` |
| AccessKey ID / Secret | 第 3 步创建的 RAM 用户凭据 |
| 图片公开访问 URL | `https://img.example.com` |
| 上传路径模板 | `images/{hash}.{ext}` |
| 本地图片文件夹 | 如 `assets`，填写真实库内路径 |
| 扫描间隔 | 如 30 分钟 |
| 初次测试删除方式 | 保留本地原图 |

阿里云当前 Node.js S3 SDK 示例采用 `https://s3.oss-cn-hangzhou.aliyuncs.com` 与 `cn-hangzhou`。插件据此自动生成请求地址，例如 `https://obsidian-images-example.s3.oss-cn-hangzhou.aliyuncs.com/images/文件.png`；图片公开访问 URL 仍使用你绑定的图片域名。[使用 AWS SDK 访问 OSS](https://help.aliyun.com/zh/oss/developer-reference/use-aws-sdks-to-access-oss)

在独立测试库按顺序验证：

1. 点击「测试连接」：此操作只列举存储桶，需要 `oss:ListObjects`，不上传或删除文件。
2. 放入一张可公开的测试图片，在笔记中插入本地图片引用，执行插件的当前笔记上传命令。
3. 确认原引用已替换为图片域名下的链接，能显示图片，本地原图仍保留。
4. 开启「定期自动扫描全库」，填写间隔，例如 30 分钟；经过第一个间隔才开始自动处理，Obsidian 需保持运行。
5. 云端删除只用专门生成的测试图片验证：移除它在笔记中的所有引用，点击「检索图片」，勾选后预览「本地＋图床删除」。有引用或缺少上传记录时不会允许删除云端对象。

配置和上传记录存放在当前库 `.obsidian/plugins/s3-image-sync-local/data.json`；升级时保留此文件，不要把它分享或提交到公开仓库。

## 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 当前 `.3` 版填 OSS 参数仍失败 | 升级 `.4`，服务商选择「阿里云 OSS」 |
| 图片访问返回 403 | 公共访问阻止、Bucket/Object 权限，或防盗链规则 |
| 控制台能上传，但程序上传失败 | RAM 策略、AccessKey、请求签名、Region 和 Endpoint 是否匹配 |
| 上传成功但笔记不显示 | 公网读取、图片访问域名、HTTPS、URL 路径和文件类型 |
| 浏览器出现下载行为 | 检查自定义域名、Content-Type 和 Content-Disposition |
| 本地能删除，图床删除失败 | RAM 是否有对应对象的 DeleteObject 权限、插件是否有该对象上传记录 |

截至本说明日期，没有使用真实 OSS 账号完成插件联调。
