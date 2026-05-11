# Anydocs Starter 示例

这是仓库中保留的最小完整 Anydocs 项目。

当你想了解基础项目结构，又不希望混入模板、导入暂存或 agent 特定指引时，可以参考这个示例。

## 目录结构

```
examples/starter-docs/
├── anydocs.config.json      # 项目配置
├── anydocs.workflow.json    # 工作流标准定义
├── pages/                   # 页面内容（规范 DocContentV1 JSON）
│   ├── zh/*.json           # 中文页面
│   └── en/*.json           # 英文页面
├── navigation/              # 导航树
│   ├── zh.json             # 中文导航
│   └── en.json             # 英文导航
└── .gitignore              # 忽略 dist/、.anydocs/
```

## 示例涵盖内容

- 最简双语文档项目
- 页面和导航的源文件布局
- `build` 和 `preview` 工作流
- Studio 本地编辑

## 示例未涵盖内容

- 自定义页面模板
- metadata schema
- 导入暂存
- agent / MCP 创作工作流

以上主题请参考 [../README.md](../README.md) 中列出的专项示例。

## 快速开始

### 构建

```bash
node --experimental-strip-types packages/cli/src/index.ts build examples/starter-docs
```

### 预览

```bash
node --experimental-strip-types packages/cli/src/index.ts preview examples/starter-docs
```

### 配合 Studio 开发

```bash
pnpm dev
```

然后打开 Studio，将 `examples/starter-docs` 设置为项目路径。

## 创建自己的项目

### 方式一：使用 CLI init

```bash
node --experimental-strip-types packages/cli/src/index.ts init ./my-docs-project
```

### 方式二：复制本示例

```bash
cp -r examples/starter-docs ./my-docs-project
```
