# 如果降雨数据变成雨 · When Rainfall Data Becomes Rain

> 把一天的降雨数据变成一场真实的雨 —— Three.js + WebGL + 自定义 GLSL Shader 实时粒子雨景。

**▶ 在线体验：[yanx5433-cmd.github.io/rain-as-data](https://yanx5433-cmd.github.io/rain-as-data/)**（建议屏幕调亮）

![demo](docs/demo.gif)

![screenshot](docs/screenshot.png)

一次对「数据可视化 × 粒子特效」的实验：26 个降雨观测点被摆放成一条时间轴上的雨柱，
每一根柱子就是那个时刻的雨 —— 雨量越大，雨柱越高、越密、越亮。时间游标缓缓走过一天，
右上角实时显示当前时刻的降雨强度。

## ✨ 特性

- 🌧️ **GPU 实例化雨幕**：十几万颗朝向相机的拉伸雨丝全部在顶点着色器里运动，位置不经过 CPU；
  雨脊高度就是数据折线本身，密度 ∝ v^0.75、落速 = 9+0.55v、拖尾 ∝ speed²、色温随强度由深青蓝转近白
- 🌫️ **三层空间**：近景散焦大颗 / 中景承载数据 / 远景雨雾，亮度比 1 : 0.55 : 0.22，配 FogExp2 消光拉开纵深
- 🌬️ **有风的雨**：6.2° 恒定倾角 + 无散度 curl 噪声阵风，近景偏得比远景快
- 💦 **真的落地**：涟漪与雨滴共用同一个下落周期，触地时刻对齐；湿沥青地面按镜面反射解析采样雨幕光场
- ⏱️ **一天回放**：播放头沿 00:00 → 24:00 推进，同步驱动 3D 高亮、HUD 读数、折线图标记与表格高亮
- 🎥 **段落式运镜**：贴地掠过 → 抬升看轮廓 → 推近看雨丝 → 拉远收尾，段间 easeInOutCubic 呼吸 + 手持微抖；
  拖拽时镜头完全交给 OrbitControls，松手 4 秒后用 2.5 秒缓动并回段落机位
- 🎬 **电影感后期**：柔焦光渗 → UnrealBloom → 暗角 / 细颗粒 / 0.4px 色差 / 冷色 lift → ACES，全部在 GPU 上
- ⚡ **自适应画质**：按 GPU 与帧率自动下调实例数与内部分辨率，移动端降到 ≤8 万颗并关闭柔焦
- 📊 **数据面板**：毛玻璃质感面板，含降雨强度折线图与 26 个时间点数据表，可收起
- ⚡ **零构建、全本地**：无打包器、无外部请求（Three.js 已本地化），克隆即用

## 🚀 运行

```bash
# 任意静态服务器指向本目录即可，例如
python -m http.server 8642
# 然后打开
# http://127.0.0.1:8642/index.html
```

Windows 用户可直接双击 `启动雨景.bat`。

> 需要支持 ES Modules 与 Import Map 的现代浏览器（Chrome 89+ / Edge 89+ / Safari 16.4+ / Firefox 108+）。

## 🛠️ 技术栈

| 模块 | 实现 |
| --- | --- |
| 渲染 | Three.js r160 + EffectComposer + UnrealBloomPass + 两段自定义 ShaderPass |
| 雨幕 | `InstancedBufferGeometry` + 3×`InstancedBufferAttribute`（每滴 12 float），顶点着色器算位置与 billboard |
| 落地 | 同相位实例化环面 quad（涟漪 + 触地闪光），半径 ∝ 雨量 |
| 地面 | 自定义着色器：解析镜面反射雨幕光场 + 低频湿斑噪声 + 体积感光晕 |
| 密度 | 沿 x 的连续密度场 λ(x) = (v/VMAX)^0.75 · 柱心高斯，CPU 拒绝采样一次成型 |
| UI | 原生 HTML/CSS（毛玻璃面板、SVG 折线图） |

## 📂 结构

```
rain-viz/
├── index.html        # 页面骨架 / HUD / 数据面板
├── main.js           # 场景、着色器、运镜、回放逻辑
├── style.css         # 界面样式
├── lib/              # 本地化的 Three.js 及插件（离线可用）
└── 启动雨景.bat       # Windows 一键启动
```

## 🎨 修改数据

编辑 `main.js` 顶部的 `values` 数组（26 个毫米/小时数值）即可换上你自己的降雨数据；
时间点会自动均匀铺满 00:00 – 24:00。

## 🙏 灵感来源

灵感来自抖音博主 **@afterimage** 的作品《如果降雨数据变成雨，大概是这样》
（[原视频](https://www.douyin.com/video/7665305181642312966)），本项目是依照其视觉效果的
Three.js 复刻与再实现，向原作者致谢。

## 📄 License

[MIT](LICENSE)
