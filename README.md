# 布尔金课堂访谈

这是一个在 Windows 上运行的课堂访谈应用，提供桌面窗口和本机浏览器 WebUI 两种入口。学生可以用麦克风或文字提问，界面显示问题和布尔金的回答，并播放语音、驱动本地人物动作。应用直接连接阿里云百炼的 `qwen-audio-3.1-realtime-flash`，不需要部署远程服务。

## 准备

- Windows 10/11 64 位、可用的麦克风和扬声器。
- 可调用 `qwen-audio-3.1-realtime-flash` 的阿里云百炼 API Key。Base URL 默认填入百炼公共实时接口，也可改为对应的专属实时地址。
- 从源码运行或打包需要 Node.js 22 及以上。

首次打开应用，在“模型设置”中确认 Base URL 并填写 API Key，不需要另填业务空间 ID。默认 Base URL 为 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`；也可填专属域名的实时接口地址。应用会补上固定的模型参数。密钥由 Electron 主进程加密保存在 Windows 用户目录，不交给页面脚本；[接口地址与鉴权说明](https://help.aliyun.com/zh/model-studio/audio-realtime-websocket-access)。

默认音色是沉稳男声 `longsanshu_v3.1`，语速为 0.9，可在模型设置中选择其他男声、调整语速或填入已有的 Flash 专属音色 ID。试听仍调用 `qwen-audio-3.1-realtime-flash`。如果日后有参考录音，可在应用内点击“导入参考录音并复刻”：Windows 主进程直接将音频发送至百炼 `voice-enrollment` 接口，生成绑定 `qwen-audio-3.1-realtime-flash` 的音色 ID，然后用于后续访谈；不经过自建服务端，也不需要新增业务空间 ID 输入。参考录音支持 WAV、MP3、M4A，文件不超过 10 MB，推荐 10–20 秒清晰单人朗读。[音色复刻要求](https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide)、[实时模型音色配置](https://help.aliyun.com/zh/model-studio/audio-realtime-voice-cloning-api)。

## 运行

在 PowerShell 中执行：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm ci
npm run desktop
```

点击“开始访谈”后，点击话筒开始录音，再点一次结束；也可在文字框输入问题，按 Enter 发送、Shift+Enter 换行。教师可先点“教师核验”，让下一轮语音或文字提问进入核验模式；也可以在问题开头说出或输入“教师核验”。核验只作用于当前轮。重新开始会清空本次访谈记录。

### 本机浏览器 WebUI

安装桌面应用后，在窗口顶部点击“打开 WebUI”，浏览器会打开同一应用提供的本机网页。桌面端与网页端共用 Base URL、音色设置和由 Windows 加密保存的 API Key，无需再填一次；关闭桌面应用时，本机网页服务也会停止。默认地址是 `http://127.0.0.1:4173`，如果端口已被占用，会自动选择其他本机端口。

也可从源码目录双击 [启动WebUI.cmd](./启动WebUI.cmd)，或执行 `npm run web` 单独运行网页入口。独立 WebUI 便携包可用 `npm run dist:web` 生成，解压后无需另装 Node.js。

百炼实时 WebSocket 要求 `Authorization` 握手请求头，浏览器不能直接设置，因此 WebUI 由这台 Windows 电脑上的轻量进程连接模型；网页仅监听本机回环地址，不提供局域网或公网入口。[百炼鉴权说明](https://help.aliyun.com/en/model-studio/audio-realtime-websocket-access)、[浏览器 WebSocket 接口](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)。只有单独运行 WebUI 时，API Key 才仅保存在本次启动进程的内存中，重启需重新填写。不要直接用 `file://` 打开网页文件。

构建 Windows 安装包：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist:win
```

安装包输出到 `release/`。当前安装包未配置代码签名，Windows 可能显示发布者未知。课堂投影可使用应用内的全屏按钮。

## 实现与边界

- 人物事实边界和对话规则见 [角色设定](./desktop/runtime/persona.txt)。普通回答目标为 50–100 字，复杂问题上限 140 字。
- 同一个 Qwen Realtime 模型完成语音转写、回答生成和语音输出。文字提问直接进入同一套回答、事实检查、动作和播报流程。客户端在播放前清理动作标签，检查文本事实、长度与语音字幕；验证失败时会显示具体原因，不会播报未经核验的内容。语音输入为 16 kHz PCM，模型输出为 24 kHz PCM。音色复刻仅在主动导入录音时使用独立的创建接口，正常访谈仍只调用 Flash 模型；[模型语音格式说明](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)。
- 模型可通过同一 Realtime API 的 Function Calling 输出动作信号。应用只接受预定义动作，每轮最多执行一个，然后驱动本地透明人物图层；[Function Calling 事件说明](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)。
- 舞台有访谈室、骑车街道、旧宅楼梯、墓园归途和教师资料室五张完整背景。客户端根据语音转写及回答中的明确情境词自动切换，教师核验时切到资料室；背景切换不增加模型调用。
- 舞台和人物的九张运行时图片采用 WebP，合计约 1.76 MB。口型音量更新限制在约每秒 30 次，并跳过未变化的样式值。
- 由于没有服务端，API Key 必须保存在这台 Windows 设备上。请使用专供课堂的百炼密钥，并在百炼控制台管理其权限与额度。模型服务、网络和账号配额会影响实际响应速度。

## 验证

```powershell
npm test
```

自动化测试覆盖固定开场、文字与语音共用的回答流程、教师核验、已知与未知事实、楼梯现场的来源边界、回答长度和动作限制。真实语音效果还需在配置有效百炼密钥的 Windows 设备上试听；仓库不包含任何真实密钥。

## 许可与公开内容

项目采用 [MIT License](./LICENSE)。公开仓库包含运行与构建所需的源码、测试和 WebP 素材；原始参考图、教学规划文档、本机设置、构建产物和调试输出不纳入仓库。
