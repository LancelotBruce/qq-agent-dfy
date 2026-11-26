# QQ Agent 0.5.1 · 内核源码与扩展插件（脱敏副本）

> **非官方二开版本。** 原作者为 **Kondius**（[GitHub](https://github.com/K0nd1us) ｜ [博客](https://www.kondius.cn/) ｜ [原项目 QQ-agent](https://github.com/K0nd1us/QQ-agent)）。授权依据与使用边界见文末「原作者与开源声明」。

QQ Agent 是一套「薄内核 + 全插件」架构的 QQ 机器人桌面端：Electron 外壳负责界面与控制台，内核负责会话调度、提示词组装与插件加载，具体能力（记忆、表情、群聊分寸、链接解析等）全部由 `extensions/` 下的插件与技能提供。

本仓库是 **0.5.1 版本的源码快照**，只保留可读、可改的代码部分：

- 仓库内包含：内核 `resources/app` 的 `src / ui / bundled / plugins / skills / overrides / docs / examples / scripts`，以及 `extensions` 下的全部插件与技能
- 仓库内不包含：Electron 运行时二进制（`QQ Agent.exe`、`*.dll`、`*.pak`）、`node_modules`、OneBot 协议端的程序与配置、任何账号 / 密钥 / 令牌 / 聊天记录 / 记忆库 / 表情库 / 日志。可运行的客户端整包见下方「直接运行」
- 文中出现的 `1000000000`、`2000000000` 一类号码均为占位值，不是真实账号

## 直接运行（不用自己装依赖）

[Releases](https://github.com/LancelotBruce/qq-agent-dfy/releases) 里有一个约 155 MB 的 Windows x64 便携包，解压即用，与本文源码同版本：

1. 解压到短路径，例如 `D:\QQAgent`（不要放 `C:\Program Files`，那里没有写权限，数据写不进去）
2. 双击 `启动.cmd`，或直接双击 `QQ Agent.exe`
3. 控制台出现 `控制台：http://127.0.0.1:3210/` 后，浏览器打开该地址即可
4. 连 QQ 需自备 OneBot v11 协议端（NapCat / LLOneBot 一类，需先装官方 QQ NT）。协议端不在仓库与发布包内：那属于第三方注入工具，不在本项目授权范围内，也不适合随包分发。协议端没起来时面板照样能开、插件照样能加载，只是发不出消息

包里剥掉了 `data-v05` 个人数据、`config`（含 token 与账号）、`logs` 与全部 `*.bak`，首次启动会在包内新建空的数据目录。首次开机要填的必填项见下方「首次配置必填项」。

想改插件就用这份源码：`extensions/plugins/<id>/index.js` 改完在面板里重启该插件即可；改内核则改 `resources/app/src`，用发布的 `resources/app` 整目录替换。

## 目录结构

完整文件树（656 个文件、逐目录体积）见 [`目录结构.md`](目录结构.md)；可折叠、可搜索的浏览器版见 [`仓库目录可视化.html`](仓库目录可视化.html)（下载后用浏览器打开，离线可用）。

```
.
├─ resources/app/           内核源码（对应安装根 resources\app）
│  ├─ src/                  主进程、控制台路由、提示词、技能加载
│  ├─ ui/                   控制台前端（面板、外壳、组件）
│  ├─ bundled/              内置能力（OneBot 传输层、兼容层、市场等）
│  ├─ plugins/              随包内置的插件副本（带 _1 后缀）
│  ├─ skills/               随包内置的技能副本
│  ├─ overrides/            组合层覆盖补丁（persona-detail 管理面板）
│  ├─ docs/ examples/ scripts/
│  └─ package.json
└─ extensions/
   ├─ plugins/              13 个插件（实际启用位置）
   └─ skills/               3 个技能
```

## 插件

| 插件 | 版本 | 作用 |
|---|---|---|
| affinity | 1.7.1 | 记录群友对机器人的好感度、群友之间的关系网，支持主人记账打赏 |
| ai-flavor | 1.0.1 | 抑制 AI 八股腔（「我记下了」这类套话） |
| at-identity | 1.0.0 | 把消息里的 @ 渲染成 @昵称(QQ号)，并注入身份锚点，避免「一出现 @ 就以为在叫自己」 |
| bili-video | 1.0.5 | 识别 B 站链接与分享卡片（含 b23.tv 短链），下载视频发群并附标题 / UP 主 / 时长；不走模型 |
| cache-stability | 1.0.0 | 把易变内容（记忆、表情）移到历史之后，提高输入前缀复用率 |
| chatter-guard | 1.0.0 | 连续发表情或灌水时主动收口 |
| conversation-memory | 1.1.1 | 把聊天压缩成日块索引，按需检索长期记忆，平时不进提示词 |
| early-finish | 1.2.0 | 发言完成后若无遗留动作就直接结束本轮，减少无谓的模型调用 |
| group-manner | 1.0.0 | 群聊分寸：只在被叫到或感兴趣时开口，私聊不受影响 |
| memory-plus | 2.12.0 | 长期 / 短期两层记忆，接管控制台「记忆」页，含整理、检索、回档、省 token 护栏 |
| sticker-steal | 5.5.8 | 自动收集群友表情到本地库并按需配图；启用后接管「发表情」这件事 |
| topic-ledger | 1.2.9 | 群聊话题台账：按话题归档、回溯与补录，减少重复讨论 |
| xhh-post | 1.0.11 | 识别小黑盒帖子链接，抓正文与评论后压缩成一段总结发群 |

## 技能

| 技能 | 版本 | 作用 |
|---|---|---|
| deepseek-balance | 1.9.1 | 查询 DeepSeek 余额与当日用量 |
| memory-recall | 1.1.5 | 按关键词与日期检索长期记忆块，支持「前天下午」这类相对时间 |
| persona-detail | 1.2.4 | 人设细节档案按需调取，新环境可用 `bootstrap_persona_detail` 从角色卡自举拆分 |

## 本地运行

本仓库不含运行时，需要一份已安装好的 QQ Agent 0.5.1 宿主（Electron 壳 + 协议端）：

1. 插件：把 `extensions/plugins/*`、`extensions/skills/*` 放进安装根的 `extensions/` 对应目录，重启宿主或在控制台「技能」页点重载。
2. 内核：把 `resources/app` 覆盖到安装根的 `resources\app`（覆盖前先备份），再执行 `npm install --omit=dev` 补齐依赖。
3. 宿主要求 Node.js ≥ 20（`resources/app/package.json` 的 `engines`）。
4. 协议端（OneBot）由宿主按自身设置拉起，不在本仓库内。

## 首次配置必填项

| 项目 | 位置 | 说明 |
|---|---|---|
| 机器人 QQ | 协议端登录 | 登录后自动识别 |
| 主人 / 管理员 QQ | 插件设置 `ownerQq` / `adminIds` / `allowSenders` / `ownerQQ` | 仓库内为占位号，必须改成自己的号，否则管理类权限不生效 |
| 模型接口 | 核心设置 `api.baseUrl` / `api.apiKey` / `api.model` | 任何 OpenAI 兼容服务均可 |
| 记忆目录 | `memory-plus` 的 `storeDir` | 默认 `D:\QQAgent\data\记忆`，按实际环境改 |
| 人设存档目录 | `persona-detail` 的 `storeDir` | `store.json` 首次由插件自动创建 |

## 安全与合规

- 仓库内不含任何真实凭据；如果你在自己的分支里填了 Key，请改用环境变量或本地配置文件，并确保它们被 `.gitignore` 排除。
- 自动化操作 QQ 账号存在被风控、限制登录甚至封号的风险，也可能违反平台服务条款。本项目仅供学习与研究，使用后果由使用者自行承担。
- 请勿用本项目批量加群、群发、采集他人信息或从事任何违法用途。
- 插件会读取群聊内容并落盘到本地（记忆、画像、话题台账），部署前请确认群内成员知情并遵守当地隐私法规。

## 原作者与开源声明

### 原作者与上游

| 项目 | 链接 |
|---|---|
| 原作者 | **Kondius** |
| 作者 GitHub 主页 | <https://github.com/K0nd1us> |
| 作者博客（开发后记 / 结语 / 使用说明） | <https://www.kondius.cn/> |
| 原项目仓库（QQ Agent，作者已停更；仓库当前不可公开访问） | <https://github.com/K0nd1us/QQ-agent> |

原项目 `package.json` 标注 `license: MIT`、`author: QQ Agent contributors`，作者本人署名 **Kondius**。本仓库是它的 **0.5.1 版本**的二开快照，不是官方仓库，也未获原作者背书。

### 开源声明

1. **来源与身份**：本仓库是基于 Kondius 开发的 QQ Agent 5.x（0.5.1）修改而来的**非官方衍生版本**（modified version）。一切原始设计、内核代码与内置扩展的著作权归原作者；本仓库只对「新增/改写的插件与技能 + 脱敏整理」主张权利。
2. **许可**：上游与本仓库均采用 **MIT License**（全文见 `LICENSE`）。依 MIT 要求，本仓库保留原作者版权声明与许可全文，并在 `LICENSE` 中明确标注为修改版本、注明修改者。
3. **修改范围**：内核 `resources/app` 为原样快照（仅替换账号/群号/本机路径为占位值、移除运行期数据）；`extensions/` 下的 13 个插件与 3 个技能为在本机长期迭代后的改写版，逐版变更见各自 `plugin.json` 的「更新记录」。
4. **不含内容**：Git 树内不分发 Electron 运行时（`QQ Agent.exe`、`*.dll`、`*.pak`）、`node_modules`、OneBot 协议端（SnowLuma）程序或其配置、任何账号/密钥/令牌/聊天记录/记忆库/表情库/日志。Releases 的便携包含 Electron 运行时（Electron 与 Node 的开源许可见 `LICENSE.electron.txt`、`LICENSES.chromium.html`），但**仍不含协议端与任何个人数据**。
5. **二次分发**：可以自由使用、修改、再分发，但**必须**保留 `LICENSE` 全文、本声明与原作者署名；介绍时请写成「基于 Kondius 的 QQ Agent」，不得标注为官方版本，也不得移除或改写版权行。
6. **与第三方的关系**：本项目与腾讯 / QQ、哔哩哔哩、小黑盒、DeepSeek 等公司均无关联，相关名称仅用于说明兼容对象；SnowLuma 等第三方组件有各自的 EULA / PRIVACY，须另行遵守。
7. **免责与撤回**：自动化操作 QQ 账号存在风控、限流、封号与违反平台条款的风险，使用后果自负，本项目仅供学习与研究。**若原作者对公开本仓库提出异议，维护者将立即转为私有或下架，不以任何理由对抗原作者意愿。**


## 更新记录

- 2026-11：整理为可公开的源码快照；移除运行时二进制、协议端、`node_modules` 与全部个人数据；占位号统一为 `1000000000` 起、群号 `2000000000` 起；补全 `.gitignore`、README 与许可证声明。
- 2026-11-24：补上原作者 Kondius 的 GitHub / 博客 / 原项目链接，新增加 `NOTICE` 与「原作者与开源声明」（MIT 署名、修改标注、二次分发要求、撤回承诺）。
- 2026-11-26：按本机最新运行体重新同步——内核吸收 11-25 的改动，插件更新到 affinity 1.7.1 / conversation-memory 1.1.1 / memory-plus 2.12.0 / topic-ledger 1.2.9 / memory-recall 1.1.5；移除已卸载的 `emotion-profile`、`ai-cover`、`mimo-tts`、`api-beggar`、`persona-self-edit` 与过期的个人向 CHANGELOG。
- 2026-11-26：发布 `v0.5.1-dfy.1` 便携包（Windows x64，约 155 MB），含 Electron 运行时与 `node_modules`，解压即用；已剥离 `data-v05` 个人数据、`config`、`logs`、`*.bak` 与协议端。
