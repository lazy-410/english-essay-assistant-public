# 考研英语作文辅助助手

本地运行的小软件，知识内容来自用户提供的《考研英语作文.pdf》。核心流程不是直接让 AI 自由写作，而是依照讲义执行：

1. 拍照识别、从真题题库带入或手动输入题目
2. 提取题图事实、图表数据或小作文交际任务
3. 制定三段内容规划，再为每个内容功能绑定一个语言骨架
4. 生成作文并检查字数、任务、数字、重复和来源
5. 逐句展示内容依据与语言骨架来源
6. 将作文排到英语一/英语二真实写作答题卡，下载 A4 PDF 或 PNG

## 启动

双击 `start.bat`（单文件版双击 `考研英语作文助手.exe`）。软件会启动本地服务并打开：

```text
http://127.0.0.1:7654
```

### 激活你的副本

正式发行包需要激活码才能使用：

- 正式联网构建首次激活需要连接作者授权服务器：本地验签通过后，云端登记激活码哈希并绑定设备
- 每个激活码默认最多绑定 2 台设备；换机时由作者在可视化管理工具中解绑旧设备
- 激活成功后进入首页，之后启动会静默确认云端状态；临时断网按最近一次成功确认提供 7 天宽限
- 激活状态保存在应用本机授权目录；激活码可设置永久或固定到期日，也可由作者远程吊销

项目为零第三方 npm 依赖，无需执行 `npm install`。

### 关于 Node.js 运行时

`start.bat` 按以下顺序查找运行时：

1. 包内 `runtime\node.exe`（免安装版自带，无需安装任何东西）
2. 系统已安装的 Node.js
3. 两者都没有时，打印提示并退出

因此有四个发行版：

| 版本 | 体积 | 自带运行时 | 含 PDF 原页图 | 适用场景 |
| --- | --- | --- | --- | --- |
| Windows 单文件版 | 约 52 MB（51.6 MiB） | 是（内嵌） | 否 | Windows：双击 exe 即用，无需 Node.js |
| 免安装版 | 约 52 MB（51.6 MiB） | 是（Windows） | 否 | Windows：没装 Node.js，解压即用 |
| 完整版 | 约 141 MB（140.5 MiB） | 是（Windows） | 是 | Windows：需要点击「PXX 原页」查看原始扫描图 |
| 精简跨平台版 | 约 18 MB（17.7 MiB） | 否 | 否 | **macOS / Linux**，以及已装 Node.js 18+ 的 Windows |

四个包都同时包含 `start.bat`（Windows）、`start.command`（macOS）与 `start.sh`（Linux），按你的系统选一个用即可；单文件版在 Windows 上也可直接双击 exe，效果等价。

如果精简版报 `No Node.js runtime available`，改用免安装版，或从 <https://nodejs.org> 安装 Node.js 后重试。

内置运行时为官方 Windows x64 版 `node.exe`，因此**Windows 单文件版、免安装版与完整版仅支持 64 位 Windows**。32 位系统请使用精简版，并自行安装对应架构的 Node.js。

## macOS / Linux

下载**跨平台版**。软件主体是纯 Node.js 实现，绝大多数功能与 Windows 一致。

启动方式：

```bash
# macOS：双击 start.command，或在终端执行
./start.command

# Linux
chmod +x start.sh && ./start.sh
```

macOS 若提示「来自身份不明的开发者」，右键点击 `start.command` → 打开；若双击无反应，先执行 `chmod +x start.command`（解压工具有时会丢失可执行权限）。

与 Windows 的差异只有两处：

| 功能 | 说明 |
| --- | --- |
| 拍照识题 | Windows 用系统内置离线 OCR，macOS / Linux **没有等价组件**。需在「设置 → OCR」配置百度 OCR；或直接把题目文字粘贴到「题目文本」框，成文效果不受影响。软件会自动检测平台并把不可用选项置灰。 |
| 打印 PDF | 依赖系统中文字体。macOS 自动查找宋体 / 冬青黑体 / 华文黑体 / 苹方；Linux 查找 Noto CJK 与文泉驿（`sudo apt install fonts-noto-cjk`）。`.otf` 字体无法内嵌，需要 `.ttf` 或 `.ttc`。找不到时给出明确提示，不会产出乱码文件。 |

成文链、真题题库、知识库、学习卡片与进度、行文复盘、答题卡排版（23 个字体与背景图随包内置）在各系统上均无差异。

> **验证程度说明**：跨平台逻辑分支已有 `scripts/verify-platform.mjs` 自动化回归覆盖，并已确认 Windows 原有功能无回归。但作者没有 macOS 设备，**字体自动查找与双击启动尚未在真实 Mac 上实测**，遇到问题最可能出在这两处。

## 首次配置

打开软件的「设置」页：

- 填写 DeepSeek API Key，判断与润色默认使用 `deepseek-v4-flash`
- 填写千问 / 百炼 API Key，视觉模型默认使用 `qwen3.7-plus`
- 分别点击两个区域的「测试连通性」确认可用

API Key 保存在本机项目目录的 `config.json`，不会写进前端代码或知识库。开发测试完成后，可在设置页点「清除 Key」，也可以打开 `config.json` 将 `deepseek.apiKey` 改为空字符串。建议同时前往 DeepSeek 平台撤销旧 Key。

## OCR

默认使用 Windows 内置 OCR，免费且离线，但复杂排版或低清照片可能识别不准。软件会再用 DeepSeek 清洗常见 OCR 错误，提交生成前请人工核对题目文本。

如需更高精度，可在设置页切换到百度 OCR，并填写百度 API Key 与 Secret Key。首选后端失败时，如另一个后端已配置，软件会自动兜底。

## 知识库

正式知识库位于 `knowledge/`：

- `pages.json`：47 页结构化知识
- `templates.json`：模板句与占位符
- `vocab.json`：讲义题目相关词表
- `layout.json`：卷面排版规范
- `index.json`：检索索引

当前验收结果为 47 页、378 条模板、207 个词条；写作知识库 V2 包含 131 条方法备注、372 条生产骨架、1103 个变体和 269 个实例。知识库页面可打开对应 PDF 原页图片进行追溯。

### 备考方向（英语一 / 英语二）

首次打开会引导选择备考方向，之后可在「设置 → 备考方向」切换。归属按讲义来源划分为三类：英语一专属 80 条、英语二专属 72 条、两者通用 220 条。

| 方向 | 主线（计入进度） | 拓展（默认不计入） | 可背总量 |
| --- | --- | --- | --- |
| 英语一 | 图画大作文 + 小作文，295 条 | 图表 5 条 | 300 条 |
| 英语二 | 图表大作文 + 小作文，273 条 | 无 | 273 条 |

英语一 2024 年考过图画与图表混合题、2025 年考过图表题，因此图表模板不隐藏而是作为「拓展题型」保留，可在卡片页勾选「纳入拓展题型」一并背诵。英语二从未考查图画大作文，故不显示图画模板。两个方向的进度分别保存，切换不丢，各自都能背满 100%。

### 知识库子页面

- **模板字典**：按关键词、分类与题型检索模板句。
- **学习卡片**：按当前方向的轨道与模块顺序切成学习单元，支持每日数量、三种掌握状态、自测模式与四种筛选；每张卡片标注英语一专属 / 英语二专属 / 通用。进度保存在 `knowledge/study-progress.json`，换浏览器或清缓存都不会丢，发行包不携带用户进度。
- **行文解析（真题范文精讲）**：对 60 道已校对范文真题逐句说明功能、位置理由与对应讲义页码，默认完全离线；配置 DeepSeek 后可叠加 AI 深化讲解，失败时自动回退离线结论。无范文的 14 道题只提供题型结构解析，不编造范文。
- **模块组装**与**组装演练**：按写作顺序选句、填占位符并实时预览。

### 批改作文（自己手写的作文）

顶部「批改作文」页，三步流程：

1. **上传识别**：拍照 / 截图 / 粘贴作文图片，也可跳过识别直接手动输入。手写作文默认走视觉模型转写（见下），照片横躺也能读。
2. **校对确认**：识别结果填入可编辑文本框，题型自动判定并给出依据。**必须点「确认文本并开始批改」才会进入批改**，软件不会拿未核对的识别结果直接改。
3. **批改结果**：分档与得失分点 + 三级修改项（必改 / 建议 / 结构），逐条采纳或忽略，生成终稿，可复制、导出报告 PDF 或送入答题卡排版。

#### 手写照片识别

手写作文默认走**视觉模型**转写，不用本地 OCR。同一张旋转 90° 的连笔手写照片实测对比：

| 通道 | 结果 |
| --- | --- |
| Windows 内置 OCR | 可辨认字符仅 35%，输出 `D 巴 ' 乙 夕` 类乱码 |
| 视觉模型（千问） | 完整转写 96 词，无法辨认 0 处，并自动纠正旋转 |

- 照片横躺也能读，视觉模型自行判断方向，界面会显示检测到的旋转角度。
- **只转写不改写**：严禁修改语法、拼写与用词，学生的错误原样保留（那是批改的对象）；辨认不出的词标 `[?]`，不猜测。
- 未配置千问视觉 Key 或调用失败时自动回退本地 OCR，并提示配置 Key 可大幅提高准确率。
- 另提供「左转 / 右转 90°」手动旋转按钮；手动转过后软件以用户选择为准。

#### 选定真题批改

第二步可选「对照真题批改」，按 **英语一/英语二 → 大作文/小作文 → 年份 → 题目** 四级联动选题。选定后自动带入官方题干、图表原始数据与校对范文：字数与任务校验按官方 Directions 判定，图表数字用题库权威数据核验，并与范文对比字数、段落、模块覆盖及用词差异。题目下拉标注「有范文 / 无范文」（60 题有范文），无范文时只用题干校验且不编造范文。自拟题目切到「不指定真题」即可。

#### 语法错误检查

语法错误单独成组并排在所有修改项**最前**。覆盖主谓一致（`Employees … has` → `have`）、冠词（`a apple` → `an apple`）、动词形式（`should pays` → `should pay`）、时态、单复数（`a informations` → `information`）、易混词（`it's impact` → `its impact`、`there career` → `their career`）、高频误拼、大小写与标点。

策略是**宁可漏报也不误报**：`an hour`、`a university`、`A number of students has applied` 这类容易被机械规则误判的正确写法都已排除（回归中有 44 句反例守着零误报）。

局限如实说明：这是规则检查，**不是完整语法分析器**，会漏掉搭配不当、句子结构混乱等需句法分析的问题。勾选「AI 复核语法」可补充，且模型报的错必须能在原文中原样定位，否则丢弃。

#### 分项估分

四个维度给区间分（大作文 20 分制、小作文 10 分制）：内容 30%、结构 25%、语言 30%、格式 15%，每项附扣分原因。

#### 依据来源

每条修改都必须可追溯，来源只有五类：

| 依据类型 | 说明 |
| --- | --- |
| 讲义功能句 | 给出骨架编号与讲义页码，可点开原扫描页核对 |
| 讲义词表 | 词汇替换只从 207 个讲义词条取值，词表里没有的一律不建议，不造「高级词」 |
| 讲义易错提醒 | 如「结尾段不要再引入新信息」，附原文与页码 |
| 语法规则 | 标注具体规则名，片段必须能在原文中定位 |
| 软件自检规则 | 字数、图表数字校验、重复表达、模块顺序，与生成作文同一套规则 |

无依据的条目不会出现，该约束由 `scripts/verify-essay-review.mjs` 保障。

两点如实说明：

- **分数是估算**。分项估分与档位依据讲义规则、语法规则与自检项计算，用于定位问题，不等同真实考研阅卷分数——真实阅卷还包含卷面、逻辑深度、表达地道程度等无法用规则衡量的因素。
- **识别质量不佳时会告警并跳过清洗**。无论走视觉还是本地 OCR，只要可辨认字符比例过低，软件都保留原始结果并提示重拍或手输——若让模型去清洗乱码，它会脑补出一篇你从未写过的通顺作文。

### 成文后的行文复盘

写完作文后，「写作文」页结果下方会直接给出：

- **模块组装流程条**：该轨道 6 个写作模块横向排开，标出每个模块由哪几句承担，缺失模块给出可执行的补写建议。
- **逐句拆解**：每句显示所属模块、功能标签、位置理由，以及它实际套用的讲义模板与页码；未套模板的句子如实标注「由内容规划直接实现」。
- **本次用到的模板句**：逐条列出本篇真正套用的模板，可单条或一键标记掌握状态，直接写入同一份学习进度，知识库进度条同步更新。

背诵卡片与行文精讲都能导出 A4 打印 PDF，中英文可选取、可搜索。PDF 由软件自行排版，中文取系统楷体（缺失时回退黑体、雅黑、宋体），英文使用 Times New Roman，仅嵌入实际用到的字形，无需安装任何字体。

如修改 `knowledge/raw-*.json`，重新构建前运行：

```bash
node scripts/verify-kb.mjs
node scripts/build-kb.mjs
```

## 真实答题卡排版

支持：

- 英语一 Part A / Part B、英语二 Part A / Part B 四套原版写作区域
- 完整保留答题卡边框、上下警示语、Section 标题、题号、横线与整体比例，而不是重新绘制简化横线
- 题号首行与原工具一致的特殊换行规则；英语一每栏 24 行，英语二每栏 23 行
- “模拟考场”黑字 17pt 与“红字字帖”红字 18pt 两种快捷预设
- 完整内置 `Dome/Font` 的 21 个 TTF，加上 Ink Free、Segoe Script，共 23 个字体；默认推荐舒窈英文衡水体
- 齐头式、缩进式、书信和通知类格式，黑/红/蓝/深灰颜色，12–28pt 字号、0–15° 倾斜与 −4～+4pt 基线微调
- 字体试写、实时 A4 预览、已用/可用行数与溢出提示
- 下载内嵌字体与完整原答题卡背景的单页 A4 PDF，或 2 倍分辨率 PNG（Android App 内为「分享 PDF / 分享 PNG」：经系统分享面板保存或发送，桌面浏览器仍是直接下载）

答题卡渲染为纯 Node 零依赖实现。所有背景和字体都随软件内置，免安装版运行时无需 Python，也不要求用户另行安装字体。

## 回归验收

```bash
node scripts/verify-handwriting-ocr.mjs  # 手写转写、旋转归一化、失败降级与"只转写不改写"约束
node scripts/verify-grammar-check.mjs   # 语法规则正例命中、44 句反例零误报、AI 编造片段拦截
node scripts/verify-essay-review.mjs    # 批改分级、依据可追溯、词表约束、真题对照、分项估分
node scripts/verify-platform.mjs        # 跨平台字体查找、开浏览器命令、OCR 与启动脚本
node scripts/verify-study-cards.mjs     # 学习卡片派生、计划切分与进度持久化
node scripts/verify-essay-analysis.mjs  # 三种题型行文解析与 AI 回退
node scripts/verify-print-pdf.mjs       # 打印 PDF 结构、中文子集与降级
node scripts/verify-compose-v2.mjs      # 成文链、字数与图表数字安全
node scripts/verify-content-plan.mjs
node scripts/verify-kb.mjs
node scripts/verify-writing-kb.mjs
node scripts/verify-answer-sheet.mjs
python scripts/verify-exams.py
```

授权链单独验证：

```bash
node scripts/verify-license.mjs   # 激活码验签、防伪、过期拒绝与状态持久化（第 15 套件）
```

## 隐私说明

- Windows OCR 在本机运行。
- 使用 DeepSeek 时，题目文本、内容规划和语言骨架上下文会发送给 DeepSeek API。
- 使用千问视觉时，当前题目图片会发送给阿里云百炼视觉 API。
- 使用百度 OCR 时，上传的题目图片会发送给百度 OCR。
- 激活码先在本机完成 Ed25519 签名校验；正式联网构建还会把激活码、随机设备 ID 和设备名称发送到作者的授权服务器，用于设备绑定、吊销和在线状态确认。服务器仅持久化激活码 SHA-256 哈希，不保存激活码明文。
- 软件不会主动上传整份 PDF、项目文件或本地其他数据。

## 给作者与分发者（源码构建与发码）

源码包含 `server.mjs` 入口、`lib/`（含授权核心）等模块，**分发前必须经构建脚本混淆打包**，任何发行包都不得携带 `lib/`、`scripts/keys/`、源码 `server.mjs` 或私钥。

### 密钥对（一次性）

```bash
node scripts/author-keygen.mjs --out C:/Users/xxx/english-essay-license
# 生成 private.pem（作者自己保管，切勿分发）与 public.pem
```

### 混淆发行构建

```bash
node scripts/build-protected.mjs --out C:/Users/xxx/english-essay-release \
  --license-key C:/Users/xxx/english-essay-license/private.pem
```

脚本依次执行：esbuild 打包 → 混淆（保守档）→ 注入公钥 → 构建四个发行树（Windows 单文件 exe / 免安装 / 完整 / 精简跨平台）→ **对每个发行树跑黑盒激活自检**（11 项：启动、未激活拦截、垃圾码拒绝、真码激活解锁等）→ 打 zip。不带 `--license-key` 时会用测试私钥并打印红色警告，产物仅可演练。

### Android APK 构建（安卓手机版）

工程在 `android/`（androidx + Material 3 原生界面，nodejs-mobile 内嵌 Node 服务，界面通过 OkHttp 直连本机 7654 端口调用同一套 `/api/*`）：

```bash
node scripts/build-android.mjs \
  --license-key ../secrets/license/private.pem \
  --license-url http://120.26.211.236:8080/license \
  --out ../releases/android
# 产物：../releases/android/dist/考研英语作文助手-v2.0.0-android-arm64.apk
# 不带 --license-key 会注入测试公钥（产物带 -TEST）；不带 --license-url 则构建为纯离线授权模式
```

- 必须**先注入作者公钥、再 esbuild**（脚本内已固定该顺序）；顺序颠倒会让 APK 内嵌测试公钥，正式激活码全部校验失败
- keystore（`android/app/keystore.properties` 指向 `english-essay-release-android/keystore/android-release.jks`）不入库，需自行保管；口令见同目录 `keystore-passwords.txt`
- 构建工具链：JDK 17 + Gradle 8.5 + Android SDK 34（`--tools` 指向本机 SDK/NDK 目录）

**v2.0.0 起界面为原生实现**（v1 的整页 WebView 已移除）：

- 启动链路 `SplashFragment`（Node 启动与健康检查）→ `ActivateFragment`（未激活时）→ 主框架，底部 5 个页签：写作 / 批改 / 题库 / 学习 / 答题卡
- 写作：`WriteFragment` 走 `/api/compose/stream`，进度、逐句来源、行文复盘与桌面端同源；生成结果在 `ComposeResultFragment`
- 批改：`ReviewFragment` → `ReviewResultFragment` 三步流程（上传 / 校对 / 结果），含分档估分、语法分组、修改项采纳、终稿 diff、导出 PDF
- 题库：`ExamsFragment` + `ExamDetailFragment`，四级筛选与「一键去练习 / 去批改」带入
- 学习：`StudyFragment` 下四个子页（背诵卡片 / 模板字典 / 行文解析 / 模块组装）
- 答题卡：`SheetFragment` 保留 WebView 岛屿做真原卡预览；「使用说明」等既有网页同样以岛屿内嵌（`WebIslandFragment`，站外链接与 `target=_blank` 交系统浏览器）
- 导出与拍照依赖应用内 ContentProvider `EeaProvider`：PDF/PNG 走系统分享面板（微信等目标应用可读到中文文件名）；「拍一张」拉起系统相机并把照片写回应用缓存
- 真机（ColorOS）实测要点：熄屏会冻结内嵌 Node 服务，操作前先 `input keyevent KEYCODE_WAKEUP`；重装 APK 后「备考方向」弹窗会重新出现，属正常；`svc power` 等 shell 权限被收紧，无法设常亮时注意操作节奏

### 为用户生成激活码

```bash
# 生成 1 个、2027-03-31 到期的激活码（到期日可不带 = 永久有效）
node scripts/license-gen.mjs --key C:/Users/xxx/english-essay-license/private.pem \
  --expiry 2027-03-31

# 批量 20 个并写入文件（每行一个码，便于存档/发货）
node scripts/license-gen.mjs --key C:/Users/xxx/english-essay-license/private.pem \
  --count 20 --expiry 2027-03-31 --out codes-20270331.txt
```

- 激活码先在本机离线验签；当发行构建配置了 `server.licenseUrl` 时，首次激活还必须联网完成云端登记和设备绑定
- 码内含授权到期日；到期后回到待激活状态，续期＝发新码
- 云端默认每码绑定 2 台设备，可查看最近在线时间、远程吊销或释放旧设备；服务器不可达时，已成功在线确认的设备按本地缓存宽限 7 天
- 发货前核验某个码（同私钥同源验签，不依赖构建内嵌的公钥）：

```bash
node scripts/license-gen.mjs --key C:/Users/xxx/english-essay-license/private.pem --verify EEA1…
node scripts/verify-license.mjs --code EEA1… --public-key C:/Users/xxx/english-essay-license/public.pem
```

两者输出一致（有效/无效、是否永久、到期时间、当前时间），可把输出截图发给发行人证明码的合法性。

### 统一发码与云端管理 CLI

当前生产授权服务为 `http://120.26.211.236:8080/license`。作者本机可使用统一管理脚本，默认通过 SSH 访问服务器本机管理接口，不在公网 HTTP 请求中传输管理口令：

```bash
# 检查私钥、公网服务、SSH 管理通道和云端记录
node scripts/license-admin.mjs health

# 生成一个限时码，自动预登记云端并写入本地台账
node scripts/license-admin.mjs issue --customer "张三" --expiry 2027-03-31

# 批量发码并指定码表文件
node scripts/license-admin.mjs issue --count 10 --expiry 2027-03-31 \
  --out C:/Users/xxx/english-essay-license/codes-20270331.txt

# 合并显示本地客户台账与云端设备状态
node scripts/license-admin.mjs list

# 查询、吊销、恢复某个码
node scripts/license-admin.mjs status --code "EEA1…"
node scripts/license-admin.mjs revoke --code "EEA1…"
node scripts/license-admin.mjs restore --hash "云端列表中的哈希前16位"

# 用户换机时释放旧设备
node scripts/license-admin.mjs unbind --hash "哈希前16位" --device-id "完整设备ID"

# 开关严格白名单；开启后未预登记的真码也会被拒绝
node scripts/license-admin.mjs strict on
node scripts/license-admin.mjs strict off
```

默认文件：

- 作者私钥：`~/english-essay-license/private.pem`
- 本地台账：`~/english-essay-license/license-ledger.json`
- 自动码表：`~/english-essay-license/codes-<时间>.txt`

台账保存完整激活码、客户、备注、签发时间、期限及云端状态；服务器只保存激活码哈希。`list` 和 `status` 默认不显示完整激活码，需要时可加 `--show-code`。所有默认路径和服务器参数均可运行 `node scripts/license-admin.mjs help` 查看并覆盖。

### 可视化管理工具

不想记命令时，可以直接双击项目根目录中的：

```text
license-admin-ui.bat
```

工具会自动打开本机管理页面（默认 `http://127.0.0.1:8787`），提供：

- 填写客户、备注、期限和数量，点击按钮生成激活码
- 一键复制单个码、复制全部或下载码表
- 查看云端登记、设备绑定、最近在线时间和吊销状态
- 点击按钮吊销、恢复激活码或解绑设备
- 切换严格白名单模式

可视化工具只监听本机地址，管理口令不进入网页，而是由后端继续通过 SSH 读取服务器配置。关闭启动它的黑色命令窗口即可停止工具。若浏览器没有自动打开，可手动访问 `http://127.0.0.1:8787/`。

### 安全边界（如实声明）

混淆与签名只能提高门槛，不能杜绝破解：程序内必须携带验证用的公钥与逻辑，专业逆向者可通过内存补丁或替换公钥绕过；发行物是纯本地软件、代码量有限，防逆向强度有上限。因此授权主要用于约束普通分发与协作场景，不承诺对专业破解的绝对防护；若发现大范围盗版，可考虑后续把关键数据下移服务端。私钥一旦泄露，等同于所有已发行码可被伪造，请务必离线备份、绝不随包分发。
