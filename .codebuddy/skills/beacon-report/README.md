# beacon-report

灯塔曝光上报能力，页面加载时自动上报展示/曝光事件，支持点击上报，支持自定义 `activityId`。

## ✨ 特性

- **自动加载 SDK** - 无需手动引入灯塔 SDK，动态加载
- **内置默认 appkey** - 使用腾讯新闻 appkey，无需单独申请
- **自动采集参数** - 自动获取打开环境、用户信息、渠道来源等
- **代码分离** - 生成独立 JS 文件，直接在 HTML 引入
- **Vue 支持** - 提供 `v-report-click` 指令式点击上报
- **多框架兼容** - 支持 Vue、React、原生 JS 等框架

## 🚀 快速开始

### 1. 获取 activityId

提供活动 ID（用于区分不同活动的数据）。

### 2. 生成 report.js

在项目中创建 `report.js` 文件，填入你的 `activityId`：

```js
// report.js
(function() {
  var ACTIVITY_ID = 'your-activity-id'; // 替换为你的活动ID
  var APPKEY = 'JS03W1ML3L0KIW';
  var SDK_URL = 'https://beaconcdn.qq.com/sdk/3.3.1/beacon_web.min.js';

  // ... 完整代码见 SKILL.md
})();
```

### 3. 在 HTML 中引入

```html
<script src="report.js"></script>
```

## 📋 能力列表

| 方法/指令 | 说明 |
|------|------|
| `initBeaconAndReport(activityId)` | 初始化灯塔并自动上报页面曝光 |
| `v-report-click` | Vue 指令，用于点击上报 |
| `report(EventCode, Params, Direct)` | 直接调用点击上报（非 Vue 框架） |

## 📖 使用文档

详细的使用说明、参数配置、完整示例请参考 [SKILL.md](./SKILL.md)。

## 🔗 API 参考

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `activityId` | string | 是 | - | 活动 ID |
| `appkey` | string | 否 | `JS03W1ML3L0KIW` | 灯塔 appkey |
| `versionCode` | string | 否 | `1.0.0` | 项目版本 |
| `channelID` | string | 否 | `h5` | 渠道标识 |
| `openid` | string | 否 | - | 用户 openid |
| `strictMode` | boolean | 否 | `false` | 严苛模式（调试用） |
| `delay` | number | 否 | `1000` | 延迟上报时间（ms） |

详细 API 文档请参考 [references/api.md](./references/api.md)。

## 📊 自动采集参数

| 参数 | 说明 |
|------|------|
| `activityId` | 活动 ID |
| `openEnv` | 打开环境（news/qq/wx/qqBrowser/browser） |
| `openFrom` | 渠道来源（ADTAG 参数） |
| `pageUrl` | 当前页面地址 |
| `referrer` | 来源页面 |
| `timestamp` | 时间戳 |
| `openid` | 用户 openid |
| `qquin` | QQ 号 |

## 📂 文件结构

```
beacon-report/
├── README.md           # 本文件
├── SKILL.md            # 详细使用文档
├── scripts/
│   └── beacon.ts       # TypeScript 版本源码
└── references/
    └── api.md          # API 详细文档
```

## 🔍 查看数据

上报完成后，可在灯塔平台查看数据：

> 数据看板：https://beacon.woa.com/datatalk/news_web/dashboard/321946

使用 `activityId` 筛选对应活动的数据。

## 📮 联系方式

如有问题或需要其他上报能力，请联系：luckylisali
