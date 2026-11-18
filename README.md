# 阅谱 Folio

在线使用：https://folio-face-reader-20261118.nearfinch5.chatgpt.site/

本仓库仅包含源码，PDF、笔记、登录凭据和云端文件不包含在仓库中。

基于 HTML、CSS、JavaScript 的 PDF 阅读器。文件默认在浏览器内解析；点击发布分享后，PDF 与笔记快照保存在云端 R2。摄像头始终在设备上推理。

## 云端文档分享

1. 打开自己的 PDF，完成手写、标记或文字笔记。
2. 点击顶部“分享文档”。首次发布通过 Sites 的 ChatGPT 登录识别发布者。
3. 点击“上传 PDF 并生成链接”，把只读链接发给访客。访客无需登录，直接查看原版 PDF 和笔记列表。
4. 后续修改先自动保存在本机，点击“更新已发布笔记”才会发布新的笔记快照；原链接保持不变。
5. 发布者可以撤销链接。服务器先移除分享入口，再移除文件。已下载的副本无法收回。

云端限制：PDF 最大 25 MB，笔记 JSON 最大 2 MB，每个账号最多保留 100 个分享。原稿的本机阅读上限仍为 150 MB。分享标识为随机 192 位令牌，服务端按 Sites 注入的用户 ID 校验更新与撤销权限，拒绝跨站写入。分享页面不把云端笔记覆盖到本机原稿。

运行时使用 Cloudflare Worker + R2，`.openai/hosting.json` 的 `r2` 声明 `BUCKET`。生成的 `dist/server/index.js` 提供 API；`dist/client` 提供静态资源，由 `ASSETS` binding 服务。不使用数据库。

## 启动

需要 Node.js 22 或以上版本。

```sh
npm install
npm run build
npm run dev
```

打开 http://127.0.0.1:4173 。本地服务器用 `.sites-runtime/local-bucket` 模拟 R2，通过仅在 loopback 生效的登录模拟测试发布者流程；本地测试数据不会上传生产。模拟登录逻辑不包含在生产 Worker 中。构建会从 Google 官方地址下载 Face Landmarker 模型并缓存到 `dist/client/assets/`；页面运行时模型、WASM 和字体均从本站加载。正式部署使用 HTTPS。

## 已实现

- 打开或拖入 PDF；支持密码对话框、缩略图、内嵌目录、最近文档。
- 单页、双页、分批连续阅读（每批最多 8 页）、按原页提取文字的舒适阅读。
- 缩放、裁边、旋转、三种环境主题、字号与行距调整、半屏翻动。
- 自由手写、荧光笔、文字、擦除、撤销与重做；批注按 PDF 坐标保存。
- IndexedDB 保存文件、笔记、阅读页码；JSON 备份与指纹校验导入。
- 导出合成批注的 PDF，中文文字批注使用本机字体栅格化，以保持可见。
- 摄像头转头、单眼眨眼、单侧嘴角动作；自然表情校准、灵敏度、反转、测试模式。
- 动作保持、回正释放、冷却时间、防双眼自然眨眼；多人、人脸丢失、后台、批注时暂停。
- 桌面、平板、手机自适应布局；快捷键、键盘焦点、工具说明。

## 首版边界

- 分享链接可以直接打开已发布的 PDF 和笔记；访客只读，不支持多人实时协作。笔记更新为手动发布的快照。
- 舒适模式为每页文字提取，不能保证多栏、表格、公式的阅读顺序，不包含 OCR 或乐谱识别重排。
- 导出的 PDF 批注已合成，不能在其他工具中逐笔编辑；保留 JSON 备份可在本工具恢复编辑。加密 PDF 如无法导出，应导出 JSON 备份。
- 自由批注留在原版视图，重排视图只读。
- 旋转、裁边是阅读设置，PDF 导出保留原始文档的页面方向与范围。
- 本机存储与浏览器配置相关，清除站点数据会删除文件和笔记。应定期备份。
- 面部动作可用性受设备、摄像头、光照、眼镜及个人表情习惯影响；默认只测试，校准后再启用实际翻页。上线前的自动验证不能代替真实摄像头使用测试。

## 验证

```sh
npm test
npm run build
```

测试覆盖动作保持与释放、防误触、内容哈希隔离、匿名分享读取、发布者权限、笔记版本冲突、撤销后不可读取、跨站写入拒绝及上传数据验证。

阅读侧栏采用独立 `.reading-sidebar` 类，避免 PDF.js 的全局 `.sidebar` 弹出层样式覆盖侧栏宽度和内边距；缩略图在独立网格列内自适应显示。

## 第三方组件

- Mozilla PDF.js — Apache-2.0：https://github.com/mozilla/pdf.js
- Google MediaPipe Tasks Vision — Apache-2.0：https://github.com/google-ai-edge/mediapipe
- pdf-lib — MIT：https://github.com/Hopding/pdf-lib
- esbuild（仅构建）— MIT：https://github.com/evanw/esbuild

示例 PDF 在 `build.mjs` 中生成，文字与音符图形仅用于功能演示。
