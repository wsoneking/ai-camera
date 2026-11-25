# ai-camera

一组用摄像头做输入的浏览器实验 —— 手势、姿态、人脸都在本机浏览器里识别，
画面不上传到任何服务器。

每个实验是 `projects/` 下一个独立的小项目：自带 `package.json`，自己 `npm install`、
自己 `npm run dev`，互相之间没有依赖。

## 项目

| 项目 | 说明 |
| --- | --- |
| [christmas-tree](projects/christmas-tree) | 手势控制的 3D 圣诞树（MediaPipe HandLandmarker + three.js） |

## 跑起来

```bash
cd projects/christmas-tree
npm install
npm run dev
```

## 加一个新项目

```bash
mkdir -p projects/<name>
```

放进自己的 `package.json` / `index.html` / `src/`，再在上面的表格里加一行。
共用的约定：

- **识别全部在本地。** 用 MediaPipe Tasks 的 wasm 运行时，不调远端推理服务。
- **模型文件提交进仓库**（`public/models/*.task`，按 URL 固定版本），
  **wasm 运行时不提交** —— 在 `postinstall` 里从 `node_modules` 同步，
  避免运行时和 JS 封装版本错配。可以直接抄 christmas-tree 的 `scripts/sync-wasm.mjs`。
- **摄像头需要安全上下文。** `http://localhost` 可以；手机走内网 IP 得用 https，
  所以各项目都带一个 `dev:https`（`@vitejs/plugin-basic-ssl`）。
