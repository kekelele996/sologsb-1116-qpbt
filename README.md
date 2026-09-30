# 野生菌采集鉴定图谱（gbfungiguide）

面向蘑菇野外调查爱好者与地方菌物名录整理者，把「采集点 → 形态描述 → 孢子印 → 菌褶/菌管着生方式 → 鉴定结论」整理成可对照的图谱条目，解决形态特征记不全、描述口径不一、鉴定结论缺乏依据留痕的问题。**纯前端单页应用**，数据全部保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

> 免责声明：本工具仅用于采集记录与形态整理，**内容不可作为食用依据**；鉴定须与权威图鉴和专业人员复核。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21816>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbfungiguide
FRONTEND_PORT=21816
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21816
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1116/
├── docker-compose.yml          # 顶层 name: gbfungiguide，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # record.ts / spore.ts / point.ts / identify.ts / index.ts
│       ├── stores/             # recordStore / sporeStore / pointStore / identifyStore（Zustand）
│       ├── components/common/  # SporePrintSwatch / TraitsSummary / GillAttachmentTag / GeoPointForm
│       ├── hooks/              # usePersistentStore / useCandidateMatch
│       ├── pages/              # AtlasPage / RecordDetailPage / PointsPage / FieldPage / IdentifyPage / ComparePage
│       ├── router/index.ts
│       └── utils/              # spore.ts / export.ts / id.ts / renumber.ts（正式换号纯逻辑）
```

### 测试

```bash
cd frontend
npm test     # 编译并运行：renumber 换号纯逻辑单测 + mergeStore 并入引擎集成测试（fake-indexeddb）
```

- `src/utils/__tests__/renumber.test.ts`：排序、高水位、两批轮转号段、重试不重不多号等纯函数用例；
- `src/stores/__tests__/merge.test.ts`：基于真实 Dexie + fake-indexeddb，验证引用迁移、分片失败重试、两批轮转、大批量排队、换号中途再交一批不撞号。

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| FungusRecord 菌物条目 | 正式采集编号、暂定名、菌盖（直径/形状/边缘/质地）、菌肉厚度与变色反应、着生方式、菌褶密度、菌柄、菌环菌托、气味、关联树种 | `records` |
| SporePrint 孢子印 | 印色、印形、获取时长、观察日期、样本干湿度 | `spores` |
| CollectPoint 采集点 | **正式编号前缀 code（如 BHS）**、地点名、经纬度、海拔、植被类型、基物、伴生树种、日期、采集人 | `points` |
| IdentifyLog 鉴定结论 | 结论学名、依据、参考图鉴与页码、置信度、是否待复核、复核人 | `identifies` |
| FieldNote 外业手记 | 外业阶段**只有临时编号 tempCode**，形态字段与正式条目一致，带并入状态 | `fieldNotes` |
| FieldSporePrint / FieldIdentifyLog | 挂在外业手记（临时号）上的孢子印与鉴定结论，换号后随条目迁入正式表 | `fieldSpores` / `fieldIdentifies` |
| MergeJob 并入批次 | 批次队列、分片号段分配、分片成功/失败状态（换号中途失败可按批次重试） | `mergeJobs` |

- 数据库名 `gbfungiguide`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史条目补齐「菌肉变色反应」默认值（不变色）；
- `version(3)` 新增外业手记三表与并入任务表，采集点增加 `code` 前缀；迁移时优先从既有正式号（如 `BHS-2026-001`）反解前缀，无法反解则回退 `PT1/PT2…`；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

### 外业手记并入与正式换号规则

外业手记在野外只有临时编号，孢子印和鉴定结论都挂在临时号上；在「外业手记并入」页上交后才换发正式编号并进入图谱库：

- **正式编号 = 采集点编号前缀-年份-序号**（如 `BHS-2026-007`）；同一采集点同年份内按**采集日期**排序（同日按临时号稳定排序），不同采集点/年份序号独立；
- 序号高水位 = 图谱库既有正式号最大序号 ∪ 所有在途/失败批次**已分配号段**，号段一经分配不回收；
- **两批一起交**：先「上交并入（挂起攒批）」攒两批，再「统一开始排队」，规划器按批次上交先后**轮转发号**（如 A 批占 001~200、B 批占 201~400、A 批占 401~600 …），每批分片按 采集点+年份 连续占用号段；
- 换号在**分片事务**内原子完成：写入正式条目、把挂在临时号上的孢子印/鉴定结论的引用重写到新条目 id、手记标记 merged——因此孢子印、鉴定结论、采集点统计（按 pointId）都不会指向旧号；
- **中途失败按批次重试**：只重跑失败分片，已成功分片与已占号段保留，重试幂等（规划时即固定新条目 id，已 merged 的条目沿用、不新增编号）；
- **大批量**：一次上交超过 1000 条自动进入排队，按每片 200 条分批换号（`LARGE_BATCH_THRESHOLD` / `LARGE_BATCH_CHUNK`），分片间让出事件循环以保持界面可响应；页面提供批量造数与「故障注入（第 N 片首次失败）」用于演示。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/atlas` | 图谱总览：网格卡片展示菌盖形态要点、孢子印色块与鉴定状态，按印色/着生方式筛选并新建条目 |
| `/atlas/:id` | 条目详情：形态描述分区折叠、孢子印观察登记、采集点编辑（含坐标校验）、鉴定留痕 |
| `/field` | 外业手记并入：手记（临时号）登记、批量造数、挂起攒批/直接上交、批次队列与按批次失败重试 |
| `/points` | 采集点管理：编号前缀维护、经纬度格式校验、条目数与主要基物统计、删除前校验下级条目 |
| `/identify` | 鉴定工作页：左侧勾选形态特征与印色，右侧实时给出候选名录排序，确认后落鉴定结论 |
| `/compare` | 条目对比：并排最多 3 条，逐项对照菌盖/菌褶菌管/孢子印差异并高亮 |

## 七、候选排序规则

- 权重：着生方式 26、孢子印 22、菌盖形状 12、表面质地 10、菌褶密度 10、菌盖边缘 8、菌肉反应 8、关联树种 4；
- 印色与条目着生方式若属于该印色的先验组合（如白色↔离生/弯生），计半分；
- 排序先比总分，总分相同则优先展示着生方式一致的条目。
