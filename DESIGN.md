# 设计规范 · ValuePort

本项目的视觉语言取自 [zed.dev](https://zed.dev) 的「技术制图 / 蓝图美学」，并在配色上做了取舍（详见末尾「取舍」一节）。本文档既是 **zed 设计系统的还原**，也是本仓库 **实际令牌的对照基准**——后续任何 UI 改动都应回到这里核对。

令牌定义集中在 [`public/shared/styles.css`](public/shared/styles.css) 的 `:root`；各页面（`index.html` / `valuation.html`）的内联 `:root` 只做必要覆盖。

---

## 0. 一句话

暖纸面 · 冷灰发丝线 · 套印菱形节点 · 硬边偏移投影 · 斜线/网点/方格纸三档底纹 · 系统无衬线 + 等宽 + Plex 衬线。整体克制：小圆角、发丝线、紧字距。

---

## 1. 配色

zed 用 `color-mix` 从两个基色生成两套色阶：**cream（暖，做背景）** 与 **offgray（冷蓝灰，做文字与线条）**，再叠加蓝色强调。精髓是 **暖纸 + 冷线 + 蓝点睛** 的混搭。

| zed 色阶 | 基色 | 关键值 |
|---|---|---|
| cream（暖纸） | `#7f7866` | `cream-50 #f5f4f3` → `cream-900 #38352d` |
| offgray（冷灰） | `#727a89` | `50 #e3e4e7 · 100 #ced1d6 · 200 #c0c3ca · 400 #878e9b · 1000 #0d0d0f` |
| 默认描边 | — | `#dadde2` |
| 强调蓝 | — | `blue-600 #155dfc` |

### 本项目令牌

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#f4f2ec` | 暖纸背景 |
| `--card` | `#faf9f4` | 略亮面板 |
| `--ink` / `--ink-soft` / `--ink-mute` | `#1b1a17` / `#57534a` / `#8a857a` | 文字三档 |
| `--border` / `--divider` | `#dadde2` | **冷灰描边 / 发丝线**（对齐 zed） |
| `--node` | `#c3c7ce` | 菱形节点（比线略深的冷灰） |
| `--track` / `--track-edge` / `--accent` | `#ece8de` / `#e0dccf` / `#ece8de` | **暖色填充**（hover、分段底、色带）——保持暖 |
| `--ring` / `--ring-border` | `rgba(46,64,102,.22)` / `#5a6886` | 聚焦环（克制蓝灰） |
| `--green` / `--red` | `#1f8f54` / `#c64141` | 语义色 |

> 规则：**线条/描边走冷灰**（`--border`/`--divider`/`--node`）；**背景填充保持暖**（`--track`/`--accent`/`--card`/`--bg`）。这正是 zed「暖纸 + 冷线」的组合。

---

## 2. 圆角阶梯

zed 的 `--radius-*`：`xs 2px · sm 4px · md 6px · lg 8px · xl 12px · 2xl 16px`

| 元素 | 圆角 |
|---|---|
| 按钮 / 输入 / chip / tab | `4px`（sm） |
| 快捷键徽章 `.kbd` | `2px`（xs） |
| 弹窗 / 卡片 | `8px`（lg） |
| 大特性面板 | `12px`（xl） |

---

## 3. 投影 —— 硬边偏移「蓝图投影」

zed 不用柔和 drop shadow，而是 **硬边、零模糊、双对角、半透明蓝** 的偏移投影（像印刷套印错位）：

```css
/* zed 原值 */
--sh-default: 5px 5px 0 #3d7df51a, -5px -5px 0 #3a7df81a;
--sh-alt:     5px 5px 0 #3d7df514;
```

本项目克制版（用在弹窗、登录/注册卡）：

```css
--sh: 4px 4px 0 rgba(46,84,180,.06), -4px -4px 0 rgba(46,84,180,.05);
```

按钮另用 **底缘内阴影** 做「键帽厚度」：filled 用 `inset 0 -2px 0 rgba(0,0,0,.24)`，outlined 用极淡的 `inset 0 -2px 0 rgba(60,50,25,.05)`。

---

## 4. 线条系统 & 节点

- **实线 = 结构**（框线、栏轨、分隔线）；**虚线 = 软注解**（内缩高亮盒，少量，如估值页的「建议」条、注册页激活码提示）。
- zed 真实令牌：`--node-vertical-offset: 3.5px`、`--node-horizontal-offset`（随断点 `4.5 → 45.5px`）。
- 交叉点用 **菱形 registration mark**（zed 的 `size-1.5 rotate-45 border-offgray-100 bg-white`）标在栏轨与横线相交处。

本项目的节点 = **6px 旋转方块**：白填充、1px `--node` 冷灰描边，`transform:rotate(45deg)`：

```css
.X::before,.X::after{content:"";position:absolute;width:6px;height:6px;
  background:#fff;border:1px solid var(--node);transform:rotate(45deg);z-index:2}
```

对 6px 方盒（border-box），居中在 1px 线交叉点上的偏移量为 **`-3.5px`**（页眉 `bottom:-3.5px`、页脚/估值列 `top:-3.5px`、左右 `±-3.5px`）——对应 zed 的 `--node-vertical-offset:3.5px`。
相邻两条 1px 边线相撞会变粗 → 用 `margin-top:-1px` 让其压成单根（见 `.frame-foot`）。

---

## 5. 底纹（按表面角色选用）

| 底纹 | 令牌 / 几何 | 用在 |
|---|---|---|
| **斜线 hatch** | `--hatch`：4px 周期、`rotate(45)`、1px | 空白填充条、页脚（如 `.frame-foot`） |
| **网点 dot-grid** | `--dots`：8px 格、`r=0.75` | 内容样本卡（如估值页 `.formula`） |
| **网格 line-grid** | `--grid`：1px 方格纸 | 大特性面板（备用） |
| 纯净 | — | 承载正文的主表面 |

---

## 6. 字体

- `--font`：`Inter, system-ui …`（正文/UI）
- `--mono`：`SF Mono, ui-monospace …`（数据、代码、ticker、快捷键、价格——配 `tabular-nums`）
- `--serif`：`IBM Plex Serif`（展示型标题 `h1`、品牌名）
  - 已加载斜体字面：`ital,wght@0,300;0,400;0,500;0,600;1,500;1,600;1,700`
- 品牌名 **ValuePort**：`--serif` + `italic` + `700` + `19px`
- 按钮：紧字距 `letter-spacing:-.01em`

---

## 7. 按钮（三档 + 快捷键徽章）

| 档 | 类 | 形态 |
|---|---|---|
| 填充（主操作，每屏唯一） | `.btn.primary` | 墨色底 + 键帽底缘内阴影 + 白字 |
| 描边（次操作） | `.btn` | 白底 + 冷灰描边 + 极淡底缘内阴影 |
| 纯文字（低权重/关闭） | `.btn.ghost` | 无边无底，hover 才出底色 |

- 4px 圆角；危险动作加 `.danger`（红）。
- **快捷键徽章 `.kbd`**：等宽 11px/700、2px 圆角、`min-width:18px`。仅挂在真实快捷键上（`esc` 关弹窗、`↵` 提交）。filled 上是半透明白，其余是纸色 + 发丝边。

**用法核对**：`完成/登录/注册` = 填充；`分享/复制/退出` = 描边；`取消/编辑/移除/添加` = 纯文字。

---

## 8. 顶部导航（看板）

三栏 grid（`1fr auto 1fr`，对隐藏的 tabs 也稳健）：

- **左**：`ValuePort`（斜体衬线加粗品牌，点击回 Watchlist）
- **中**：菜单 tabs（`Watchlist` / `宏观看板`），选中态为底部 **2px 墨色下划线**，压在顶栏标尺线上
- **右**：`⚙ 设置`（齿轮图标，激活态高亮）· `🌐 语言`（地球 + 可切到的语言码）

底部一条发丝线 + 两端菱形节点。**语言切换全员可见**（含访客）；**设置/分享仅主人可见**。

## 9. 视图与标题作用域

- 标题块（`.page-head`：eyebrow + 大标题 + 说明 + 行情时间）**只属于 Watchlist 视图**，切到设置即隐藏。
- **分享按钮** 在 `.page-head` 内 → 只在 Watchlist 出现（分享的就是这个列表）。
- 设置视图有自己的衬线标题「设置 / Settings」，不借用看板标题。

---

## 10. 布局结构（zed 整页拆解）

zed 整页是一套「**全宽标尺带 × 居中内容栏**」的网格系统。

### 纵向：内容段 + 分隔带交替

```
[ 内容段 section ]      ← min-h-[450px]，flex 行
[ 分隔带 h-3.5=14px ]   ← 上下各一条满幅 1px 标尺线
[ 内容段 section ]
[ 分隔带 ]
…
```

分隔带本体（实测）：14px 高空带，用 `before`/`after` 各画一条 1px 线，
关键是 **`w-[200vw] -left-[100vw]`**——线满幅出血到屏幕两端，而内容仍居中：

```html
relative h-3.5 w-full
  before: top-0  -left-[100vw] h-px w-[200vw] default-border-before-color
  after:  bottom-0 -left-[100vw] h-px w-[200vw] default-border-after-color
```

> 「全宽横线 + 居中内容」并存的诀窍：横线靠出血脱离容器，内容靠 max-width 居中。

### 横向：留白栏 — 内容栏 — 留白栏

每个 section 是 flex 行：

```
[ flex-1 gutter ]   [ 内容栏 max-w-[1100px] ]   [ flex-1 gutter ]
  border-x #dadde2                                border-x #dadde2
  hidden lg:block                                 hidden lg:block
```

- 两侧 **留白栏 `flex-1 border-x`** 弹性吸收多余视口宽度，把内容挤到居中；其**内侧边框就是竖向栏轨**。
- 桌面才显示（`hidden lg:block`），移动端塌成单列贴边。
- 内容栏 `~1100px`，正文再收到 `max-w-[580px]` 一类。
- `outer-section-node-offset` 按断点设 `--node-horizontal-offset`（`4.5 → 45.5px`），决定菱形节点离栏轨多远。

### 层级样式分工（结构层平、内容层才有阴影）

| 层 | 元素 | 样式 | 职责 |
|---|---|---|---|
| **L0 页壳** | `max-w` 容器 + 噪点叠层 | 居中、满幅出血横线、~3.5% noise | 定边界 |
| **L1 段（结构）** | `section flex + gutter border-x + 节点` | **只有线 + 菱形节点**，`min-h`，**无阴影无圆角** | 搭网格骨架 |
| **L2 内容卡（内容）** | feature card | `rounded-xs/sm` + `border #dadde2` + **偏移蓝投影** + 渐变/网点/方格/斜线底纹 | 把内容「抬」离骨架 |
| **L3 原子** | 按钮(三档+kbd)、虚线高亮、徽章、等宽标签 | 4px 圆角、键帽内阴影、`dashed` 注解 | 交互/标注 |

三条铁律：
1. **菱形节点只在 L1**（栏轨上、线交叉处），不进卡片。
2. **偏移投影只在 L2 卡片**，结构层（段/栏轨）永远纯线、零阴影。
3. **底纹按角色分**：空带=斜线、内容卡=网点、大面板=方格纸、正文=纯净。

### 我们的简化

本项目把 zed 的「per-section flex 留白栏」简化成 **整页一个 `.page` 框**（两侧 `border-x` 栏轨 + `page-head`/`frame-foot` 横线 + 菱形节点）——同一套语言的精简版，单看板页够用。

Watchlist 页内部已按区段模型分成 **标题段 / 看板段**：两者之间插一条 **14px 标尺隔断带**（`.section-divider`，上下两条发丝线 + 淡斜纹填充），复刻 zed 的 `divider-slash`。隔断带随看板段一起在设置视图隐藏。

**节点位置铁律（实测 zed）**：`divider-slash` 这类**细隔断带不带菱形节点**（只有线 + 斜纹）；菱形只钉在**结构边界**——本项目即顶栏底线、页脚顶线（每条线一对、压在两侧栏轨上）。不要在隔断带的两条线上各放一对，否则会变成「14px 内上下两颗菱形」的拥挤错位感。

若以后做**多区段落地页**（宏观看板、营销页），应上 zed 完整结构：内容段 + 14px 满幅标尺带 + flex 留白栏。

---

## 取舍（我们 vs zed）

| 维度 | 决定 |
|---|---|
| 暖纸背景 | 采纳（与 zed `cream-50` 几乎一致） |
| 冷灰线条 `#dadde2` | 采纳 |
| 硬边偏移投影 | 采纳（克制版，更淡更小） |
| 节点 / 底纹 / 按钮三档 / 顶部导航 | 采纳 |
| 强调色 | **保持墨黑 ink**，不引入 zed 蓝（只在聚焦环用一点冷蓝灰） |
