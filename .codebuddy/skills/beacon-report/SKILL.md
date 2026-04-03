---
name: beacon-report
description: 灯塔曝光上报能力，页面加载时自动上报展示/曝光事件，支持自定义 activityId
allowed-tools:
  - read_file
  - write_to_file
  - replace_in_file
triggers:
  - 上报
  - 曝光上报
  - 展示上报
  - 灯塔上报
  - 灯塔
  - beacon
  - 页面曝光
  - 点击上报
---

# 灯塔上报

页面加载时自动上报展示/曝光事件，支持点击上报，支持自定义 `activityId`。

**特性**：
- 自动加载灯塔 SDK，无需手动引入
- 内置默认 appkey，只需提供 activityId
- 生成独立 JS 文件，直接在 HTML 引入即可
- 支持 Vue 指令式点击上报

## 能力

| 方法/指令 | 说明 |
|------|------|
| `initBeaconAndReport(activityId)` | 初始化灯塔并自动上报页面曝光 |
| `v-report-click` | Vue 指令，用于点击上报 |
| `report(EventCode, Params, Direct)` | 直接调用点击上报（非 Vue 框架） |

## 使用流程

### 第一步：获取活动 ID

询问用户：

> 请提供活动 ID（用于区分不同活动的数据）

### 第二步：生成上报文件

在项目中创建 `report.js` 文件（独立于业务代码）：

```js
// report.js - 灯塔曝光上报
(function() {
  var ACTIVITY_ID = '用户提供的activityId';
  var APPKEY = 'JS03W1ML3L0KIW';
  var SDK_URL = 'https://beaconcdn.qq.com/sdk/3.3.1/beacon_web.min.js';

  // 获取 Cookie
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  // 获取 URL 参数
  function getUrlParam(name) {
    var reg = new RegExp('(^|&)' + name + '=([^&]*)(&|$)');
    var search = window.location.search.substr(1);
    var match = search.match(reg);
    return match ? decodeURIComponent(match[2]) : '';
  }

  // 获取打开环境
  function getOpenEnv() {
    var ua = navigator.userAgent;
    if (/qqnews/i.test(ua)) return 'news';
    if (/\sQQ\//i.test(ua)) return 'qq';
    if (/MicroMessenger/i.test(ua)) return 'wx';
    if (/MQQBrowser/i.test(ua)) return 'qqBrowser';
    return 'browser';
  }

  // 获取基础上报参数
  function getBaseParams() {
    var params = {
      activityId: ACTIVITY_ID,
      openEnv: getOpenEnv(),
      openFrom: getUrlParam('ADTAG') || 'unknown',
      pageUrl: window.location.href,
      referrer: document.referrer || '',
      timestamp: Date.now()
    };
    var openid = getCookie('openid') || getCookie('open_openid');
    if (openid) params.openid = openid;
    var uin = getCookie('uin');
    if (uin) params.qquin = uin;
    return params;
  }

  // 执行上报
  function doReport() {
    try {
      var beacon = new window.BeaconAction({
        appkey: APPKEY,
        versionCode: '1.0.0',
        channelID: 'h5',
        strictMode: false,
        delay: 1000
      });
      beacon.onUserAction('news_h5_common_view', getBaseParams());
    } catch (e) {
      console.error('[Beacon] 上报失败:', e);
    }
  }

  // 加载 SDK 并上报
  function init() {
    if (window.BeaconAction) {
      doReport();
      return;
    }
    var script = document.createElement('script');
    script.src = SDK_URL;
    script.onload = doReport;
    script.onerror = function() {
      console.error('[Beacon] SDK 加载失败');
    };
    document.head.appendChild(script);
  }

  // 页面加载完成后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

### 第三步：在 HTML 中引入

在 `index.html` 的 `</body>` 前引入：

```html
<script src="report.js"></script>
```

## 生成文件结构

```
project/
├── report.js      # 上报脚本（独立文件）
└── index.html     # 页面文件
```

---

## 点击上报

在 Vue 组件中，使用 `v-report-click` 指令实现点击上报。

### 使用方式

直接在 DOM 元素上添加 `v-report-click` 指令：

```vue
<div
  class="button"
  @click="handleClick"
  v-report-click="{
    EventCode: EVENT_CODE_CLICK,
    Params: {
      activityId: REPORT_ID,
      eventCode: 'saveBtn',
    },
    Direct: true,
  }"
>
  点击按钮
</div>
```

### 指令参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `EventCode` | string | 是 | 事件码，使用常量 `EVENT_CODE_CLICK`（值为 `'news_h5_common_click'`） |
| `Params` | object | 是 | 上报参数对象 |
| `Params.activityId` | string | 是 | 活动 ID，使用常量 `REPORT_ID` |
| `Params.eventCode` | string | 是 | 自定义功能参数，用于区分不同按钮/功能 |
| `Params.moduleName` | string | 否 | 模块名称，可选 |
| `Direct` | boolean | 否 | 是否立即上报，建议设为 `true` |

### 常量引入

在使用点击上报前，需要引入相关常量：

```typescript
import { EVENT_CODE_CLICK } from '@basic/utils';

// 定义活动 ID 常量
const REPORT_ID = 'your-activity-id';
```

### 完整示例

```vue
<template>
  <div class="page">
    <!-- 保存按钮 -->
    <div
      class="save-btn"
      @click="saveImage"
      v-report-click="{
        EventCode: EVENT_CODE_CLICK,
        Params: {
          activityId: REPORT_ID,
          eventCode: 'saveBtn',
        },
        Direct: true,
      }"
    >
      保存图片
    </div>

    <!-- 分享按钮 -->
    <div
      class="share-btn"
      @click="shareAction"
      v-report-click="{
        EventCode: EVENT_CODE_CLICK,
        Params: {
          activityId: REPORT_ID,
          eventCode: 'shareBtn',
          moduleName: 'result-page',
        },
        Direct: true,
      }"
    >
      分享
    </div>
  </div>
</template>

<script setup lang="ts">
import { EVENT_CODE_CLICK } from '@basic/utils';

const REPORT_ID = 'your-activity-id';

const saveImage = () => {
  // 保存逻辑
};

const shareAction = () => {
  // 分享逻辑
};
</script>
```

### eventCode 命名建议

| 场景 | eventCode 示例 |
|------|----------------|
| 保存按钮 | `saveBtn` |
| 分享按钮 | `shareBtn` |
| 下载按钮 | `downloadBtn` |
| 提交按钮 | `submitBtn` |
| 返回首页 | `goHomeBtn` |
| 查看详情 | `viewDetail` |

---

## 直接调用方式（非 Vue 框架）

如果不使用 Vue 框架，可以直接调用 `report` 或 `reportDirect` 方法进行点击上报。

### 方法说明

| 方法 | 说明 |
|------|------|
| `report(EventCode, Params, Direct)` | 通用上报方法，Direct 控制是否立即上报 |

### 引入方式

```typescript
import { report } from '@basic/report';
// 或
import { report } from '@basic/utils';
```

### 使用示例

```typescript
import { report, reportDirect } from '@basic/report';

const ACTIVITY_ID = 'your-activity-id';

// 点击上报
document.querySelector('.save-btn')?.addEventListener('click', () => {
  report(
    'news_h5_common_click',  // EventCode
    {
      activityId: ACTIVITY_ID,
      eventCode: 'saveBtn',
    },
    true  // Direct: 立即上报
  );
});
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `EventCode` | string | 是 | 事件码，点击上报使用 `'news_h5_common_click'` |
| `Params` | object | 是 | 上报参数对象 |
| `Params.activityId` | string | 是 | 活动 ID |
| `Params.eventCode` | string | 是 | 自定义功能参数 |
| `Params.moduleName` | string | 否 | 模块名称 |
| `Direct` | boolean | 否 | 是否立即上报，默认 `false` |

### 事件码常量

```typescript
// 可直接使用字符串，或引入枚举
import { ReportTypes } from '@basic/report';

ReportTypes.click  // 'news_h5_common_click' - 点击上报
ReportTypes.view   // 'news_h5_common_view'  - 曝光上报
```

---

## 参数说明

| 参数 | 说明 |
|------|------|
| `ACTIVITY_ID` | 活动 ID，必填 |
| `APPKEY` | 灯塔 appkey，默认使用腾讯新闻 appkey |

## 自动采集参数

上报时会自动附加以下基础参数：

| 参数 | 说明 |
|------|------|
| `activityId` | 活动 ID |
| `openEnv` | 打开环境（news/qq/wx/qqBrowser/browser） |
| `openFrom` | 渠道来源（从 ADTAG 参数获取） |
| `pageUrl` | 当前页面地址 |
| `referrer` | 来源页面 |
| `timestamp` | 时间戳 |
| `openid` | 用户 openid（如有） |
| `qquin` | QQ 号（如有） |

## 资源文件

| 文件 | 说明 |
|------|------|
| `{baseDir}/scripts/beacon.ts` | TypeScript 版本源码（参考） |
| `{baseDir}/references/api.md` | API 详细文档 |

## 注意事项

1. **代码分离**：上报逻辑放在独立的 `report.js` 文件
2. **SDK 自动加载**：无需手动引入灯塔 SDK
3. **默认 appkey**：内置腾讯新闻 appkey，无需单独申请
4. **activityId**：必填，用于区分不同活动的上报数据

## 查看数据

上报完成后，可以在灯塔平台查看数据：

> 数据看板地址：https://beacon.woa.com/datatalk/news_web/dashboard/321946?menuIds=menu_yp4p33oa&paramsid=8da0d075797cd20bb345d97521611ef4
>
> 使用 `activityId` 筛选对应活动的数据。

## 能力不存在时

如果用户需要的能力在本 skill 中不存在，请提示：

> 当前 skill 提供页面曝光上报和点击上报能力。如需其他上报能力，请联系维护者：luckylisali
