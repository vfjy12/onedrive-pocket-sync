# OneDrive Pocket Sync

Obsidian 的 OneDrive 同步插件，面向 iPad、iPhone 和 Windows。中文设置，个人微软账户设备代码登录，无 Node.js、文件系统模块或桌面专用接口依赖。通过 BRAT 安装。

当前版本：**0.1.0，实验版**。已提供模拟环境自动测试；真实微软授权、OneDrive API 行为和 iPad Obsidian 界面仍需实机验证。请先用测试库，不要在同一个库同时运行其他同步插件。

## 这一版怎么同步

- 同步笔记、附件和子目录；各设备填同一个 OneDrive 专用目录。
- 手动同步；可选每 1 / 5 / 15 分钟同步，仅在 Obsidian 运行期间。
- 排除所有隐藏文件/目录、Obsidian 配置目录、`OneDrive冲突副本/`。插件、主题、设置不会同步。
- 每轮完整扫描，使用本地 SHA-256 和远端 ETag 判断变化，不凭时间戳决定覆盖。
- 双方都修改，或首次遇到同名不同内容：保留原文件，将远端副本存入 `OneDrive冲突副本/`。手动合并后，设置 → 处理冲突 → 上传本地合并结果。也可以把远端副本内容复制到原文件后重新同步。
- 远端单独改变：下载前在 `OneDrive冲突副本/同步前备份-…/` 保存本地旧内容。
- 上传现有文件带 If-Match；扫描后远端改变会停止。新上传使用冲突拒绝策略。同步期间本地改变也会停止替换。
- **不传播删除**：本地删除会重新下载；远端删除会重新上传。重命名按新增处理，旧文件名可能补回。若需永久删除，先停用所有设备自动同步，在两端删除，再手动同步。
- 不处理空目录。单文件上限 20 MB，超过限制记日志并跳过。大量文件首次扫描会慢；没有大文件分块上传、增量扫描、跨设备事务锁、端到端加密或删除墓碑。

## 第一步：放到 GitHub

最简单的方法是用 GitHub 网页，**上传解压后的文件，而不是只上传 ZIP**。

1. 解压提供的 ZIP，找到包含 `main.js`、`manifest.json`、`styles.css` 的文件夹。
2. 登录 https://github.com ，点击右上角 `+` → **New repository**。
3. Repository name 填 `onedrive-pocket-sync`；选择 **Public**，创建仓库。公开仓库最方便 BRAT 安装。插件源码公开不会公开你的笔记。
4. 选择 **Add file → Upload files**。上传此文件夹内的文件，使 `main.js`、`manifest.json`、`styles.css`、`README.md` 在仓库根目录，不能多套一层 `onedrive-pocket-sync/`。
5. 提交文件后，进入仓库首页右侧 **Releases → Create a new release**。
6. Tag 输入 **`0.1.0`**，创建新 tag；标题 `0.1.0`。在附件区域单独上传 **`main.js`、`manifest.json`、`styles.css`**。
7. 不勾选 pre-release，点击 **Publish release**。下载页必须看见这三个独立附件；GitHub 自动生成的 Source code ZIP 不能代替它们。

你的仓库地址将是 `https://github.com/你的用户名/onedrive-pocket-sync`。

### 以后自动发布（可选）

源码包含 `.github/workflows/release.yml`。网页上传可能漏掉隐藏目录，可在 GitHub 使用 **Add file → Create new file**，文件名填 `.github/workflows/release.yml`，复制提供的同名文件内容。该流程在推送版本 tag 时检查语法、运行测试、发布三个 BRAT 附件。

手动创建初次 Release 与自动流程二选一，避免同一 tag 重复发布。以后把 `manifest.json`、`package.json`、`versions.json` 更新到一致的新版本，提交，再创建对应 tag（如 `0.1.1`，不带 v）。通过 Git 推送 tag 会触发流程；使用 GitHub Release 网页创建 tag 的触发行为取决于事件来源，网页方式可继续手动附加三个文件。无需 npm install，此项目没有构建依赖。

若你已安装 Git，也可以在解压后的插件目录执行（替换用户名；空的新仓库）：

```powershell
git init
git add .
git commit -m "Initial OneDrive Pocket Sync"
git branch -M main
git remote add origin https://github.com/你的用户名/onedrive-pocket-sync.git
git push -u origin main
git tag 0.1.0
git push origin 0.1.0
```

## 第二步：iPad 用 BRAT 安装

1. iPad 打开 Obsidian → 设置 → 第三方插件 / Community plugins，关闭受限模式。
2. 浏览社区插件，搜索 **BRAT**，安装并启用。
3. 进入 BRAT 设置，选择 **Add Beta plugin**（名称随 BRAT 版本可能略有差异）。
4. 输入 `你的用户名/onedrive-pocket-sync` 或完整 GitHub 仓库 URL；若询问版本，选择 `0.1.0`。确认添加。
5. 回到第三方插件列表，启用 **OneDrive Pocket Sync**，再进入其设置。

BRAT 报找不到版本时，先检查公开仓库、根目录 manifest、已发布 Release 和三个附件。不要只上传源码 ZIP。

## 第三步：注册微软应用（一次即可）

插件不内置他人的客户端 ID；你注册自己的公共客户端应用，各设备共用这个 ID。客户端 ID 可以公开；不要创建或填写 client secret。

1. 打开 https://entra.microsoft.com/ ，进入 **Identity / Microsoft Entra ID → Applications → App registrations → New registration**。也可使用 Azure 门户的 Microsoft Entra ID → App registrations。
2. 应用名称填 `OneDrive Pocket Sync`。
3. 支持的账户类型选择 **Personal Microsoft accounts only**；若门户仅提供组合项，可选择同时支持个人微软账户的类型。插件的登录端点限定个人账户，不支持公司/学校 OneDrive。
4. 注册后复制 Overview 中的 **Application (client) ID**。
5. 进入 **Authentication → Advanced settings → Allow public client flows**，设为 **Yes** 并保存。设备代码登录不需要重定向 URI。
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**，添加 **Files.ReadWrite**。运行时还会请求 `offline_access` 以续期登录。不要选择 Application permissions，不需要应用密钥。
7. 把客户端 ID 填进插件设置。点击“连接 / 重新连接”，记下代码，在 Safari 打开弹窗的微软验证地址并完成授权，回到 Obsidian 等待“已连接”。若弹窗关闭或代码过期，重新连接。

微软门户可能要求先具备可注册应用的 Entra 目录/租户；普通 OneDrive 账户不一定已具备注册权限。若无法创建应用，这一步尚未完成，插件不能登录。门户页面标签也可能调整。

设备代码协议参考：https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code

**授权范围说明：** `Files.ReadWrite` 是个人 OneDrive 文件读写权限，范围大于所选同步目录。插件代码把同步请求限制在设置的专用目录，但微软授予的权限不是目录级隔离。

## 第四步：先测一个小库

1. Windows 和 iPad 建立测试库，使用同一个个人微软账户、同一个客户端 ID。
2. 远端文件夹在两台设备都填写 `Obsidian/PocketSyncTest`。插件会创建缺失目录，不要填写 OneDrive 根目录或已有杂项的 Documents。
3. Windows 新建一篇测试笔记和一个小附件，手动同步。iPad 点击立即同步，确认内容一致。
4. iPad 修改笔记并同步；Windows 再同步，确认更新及备份。
5. 两台设备离线分别修改同一篇笔记，依次同步，确认出现冲突副本，原稿未丢失；合并后用“处理冲突”上传。
6. 测试在同步中编辑、断网、退出重开、令牌续期和大文件跳过。确认可接受后才迁移正式库；初次正式同步前另行备份。
7. iPad 阅读前同步一次，编辑结束后同步一次。iOS 后台/锁屏可能暂停应用，不能承诺后台自动同步。

当前设置页登录状态在重新打开页面时刷新；同步结果以通知、桌面状态栏和日志为准。日志只保存在当前运行内存，重启清空。退出登录清除本地令牌，不删除 OneDrive 文件；若需撤销授权，在微软账户的应用权限管理中撤销。

## 隐私与维护

令牌、客户端 ID、同步基线保存在本库 `.obsidian/plugins/onedrive-pocket-sync/data.json`（自定义配置目录时在对应目录），由 Obsidian 本地存储保存，**令牌没有额外加密**。本插件排除配置目录；其他备份/同步工具需自行排除令牌文件。GitHub 只上传交付的源码，不要上传真实库、`data.json` 或日志。插件只连接微软登录服务、Microsoft Graph 和 Graph 返回的 HTTPS 下载地址。

备份目录需手动清理；先确认原笔记和远端内容均完整。不要在多设备并发编辑时假定最后一个同步者能自动解决所有冲突。

## 本地检查

```powershell
npm.cmd run check
npm.cmd test
```

测试使用模拟 Obsidian/网络环境，覆盖变化判定、冲突保留、替换前备份、缺失文件补回、下载中编辑与上传条件。通过这些检查不代表已在真实 Obsidian、OneDrive 或 iPad 上验证。
