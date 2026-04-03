# API 文档

## initBeaconAndReport

初始化灯塔并自动上报页面曝光。

**特性**：
- 自动动态加载灯塔 SDK，无需手动在 HTML 中引入
- 内置默认 appkey，只需提供 activityId

### 函数签名

```ts
initBeaconAndReport(config: BeaconConfig): void
```

### 参数

#### BeaconConfig

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `activityId` | string | 是 | - | 活动 ID，用于区分不同活动 |
| `appkey` | string | 否 | `'JS03W1ML3L0KIW'` | 灯塔 appkey，默认使用腾讯新闻 appkey |
| `versionCode` | string | 否 | `'1.0.0'` | 项目版本 |
| `channelID` | string | 否 | `'h5'` | 渠道标识 |
| `openid` | string | 否 | `''` | 用户 openid |
| `strictMode` | boolean | 否 | `false` | 严苛模式，开启后控制台输出上报日志 |
| `delay` | number | 否 | `1000` | 延迟上报时间（毫秒） |

### 使用示例

```ts
import { initBeaconAndReport } from './utils/beacon';

// 基础用法（只需 activityId）
initBeaconAndReport({
  activityId: 'peaceDove2025',
});

// 完整配置
initBeaconAndReport({
  activityId: 'peaceDove2025',
  appkey: 'CUSTOM_APPKEY',  // 可选，使用自定义 appkey
  versionCode: '2.0.0',
  channelID: 'wechat',
  openid: 'user_openid_xxx',
  strictMode: false,
  delay: 500,
});
```

### 自动上报事件

调用后会自动上报 `news_h5_common_view` 事件，携带以下参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `activityId` | 活动 ID | `'peaceDove2025'` |
| `openEnv` | 打开环境 | `'news'` / `'qq'` / `'wx'` / `'qqBrowser'` / `'browser'` |
| `openFrom` | 渠道来源 | URL 中的 ADTAG 参数值 |
| `pageUrl` | 当前页面地址 | `'https://xxx.qq.com/activity'` |
| `referrer` | 来源页面 | `'https://xxx.qq.com/'` |
| `timestamp` | 时间戳 | `1702886400000` |
| `openid` | 用户 openid | Cookie 中的 openid |
| `qquin` | QQ 号 | Cookie 中的 uin |

### 错误处理

- `activityId` 为空时，控制台输出 `[Beacon] activityId 不能为空`
- SDK 加载失败时，控制台输出 `[Beacon] 灯塔 SDK 加载失败`

## SDK 自动加载

代码会自动动态加载灯塔 SDK：

```
https://beaconcdn.qq.com/sdk/3.3.1/beacon_web.min.js
```

无需在 `index.html` 中手动引入。

## 默认 appkey

内置腾讯新闻 appkey：`JS03W1ML3L0KIW`，无需单独申请。

## 查看数据

上报完成后，可以在灯塔平台查看数据：

**数据看板地址**：https://beacon.woa.com/datatalk/news_web/dashboard/321946?menuIds=menu_yp4p33oa&paramsid=8da0d075797cd20bb345d97521611ef4

使用 `activityId` 筛选对应活动的数据。
