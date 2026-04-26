---
name: v0.5.0 Sprint 2 UI実装コンテキスト
description: csm-ui担当タスク範囲・サービスAPI・ファイル構造の概要
type: project
---

## Sprint 2 担当タスク (T2.1〜T2.21)

**Why:** v0.5.0でCSMをMermaid/TreeView主体からCytoscape+Webviewへ刷新するため

### 完了済みサービス (csm-implが実装済み)
- `src/services/bookmarkService.ts` — getBookmarks(), toggleBookmark(), getRecentlyUsed(n), relativeTime(ms)
- `src/services/progressCalculator.ts` — computeProgress(project): ProjectProgress
- `src/services/projectService.ts` — discoverProjects(), registerProject(), removeProject()
- `src/panels/mainTabPanel.ts` — 3タブWebviewView骨格 (sessions/agents/projects)
- `resources/` — cytoscape.min.js, cytoscape-elk.js, elk.bundled.js 配置済み

### 主要データ構造
- `AgentConfig` in `src/models/types.ts` — scope: 'global'|'project', model, role, allowedTools, parentAgent
- `ProjectDef` in `src/services/projectService.ts` — id, name, path, addedAt, source, isCurrent?
- `ProjectProgress` in `src/services/progressCalculator.ts` — todos, history, pendingTasks, activeSubagents
- `MemoryFile` in `src/models/types.ts` — name, description, type, content

### dataStore.getAgents() 返す型
AgentConfig[] — agentFileManager経由でfrontmatter解析済み

**How to apply:** mainTabPanel.tsに機能追加する際は既存の_handleMessage()とpostMessageに沿って拡張する
