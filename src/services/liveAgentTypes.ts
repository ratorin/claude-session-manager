// liveAgentTypes.ts — ライブエージェント表示用の共通型 + フォーマッタ
// v0.5.22 で claudeAgentsService.ts から切り出し（同ファイルは撤去）。
//
// CC ランタイム CLI（`claude agents --json`）は VS Code 拡張ホストから TTY 無しで
// 呼び出せないため、v0.5.22 以降は agentWatcher（PID + sessions/*.json 監視）が
// 唯一のライブデータソース。本ファイルは表示層（agentLiveTreeProvider /
// orchestrationTreeProvider）が共有する型と 1 関数のみを保持する。

/**
 * ライブ状態のエージェント／セッション 1 件分の情報。
 *
 * v0.5.21 まで claude agents --json 由来のフィールドも含んでいたが、
 * v0.5.22 で agentWatcher の sessions/*.json + JSONL 解析のみが供給元となった。
 * `source` フィールドは将来別供給源が復活したときの識別用に残置。
 */
export interface ClaudeAgentEntry {
	/** CC のセッション ID（UUID） */
	sessionId?: string;
	/** CSM 登録エージェント名（照合後に設定） */
	agentName?: string;
	/** ステータス */
	status: 'running' | 'blocked' | 'done' | 'unknown';
	/** 作業ディレクトリ */
	cwd: string;
	/** 経過秒数 */
	elapsedSec?: number;
	/** プロセス ID */
	pid?: number;
	/** セッションの種別（CC 公式 `kind` フィールド: 'interactive' | 'background' 等） */
	kind?: string;
	/** セッション開始時刻（Unix ms） */
	startedAt?: number;
	/** v0.5.22: CC 公式のセッション表示名（`name` フィールド） */
	sessionName?: string;
	/** v0.5.22: name の由来（'derived' 等） */
	nameSource?: string;
	/** 取得元識別子（将来別供給源が復活した場合のため残置） */
	source?: 'session-json' | 'json-api' | 'text-parse';
	/** テキストパース時のデバッグ用（将来復活時のため型のみ残置） */
	rawLine?: string;
}

/**
 * v0.5.24: buildLiveAgentViews / buildLiveTreeStructure が受け取る AgentConfig の最小 shape。
 *
 * `dataStore.getAgents()` の戻り値をそのまま渡せる（構造的部分型）。テストからは
 * vscode モジュールに依存しないでこのモジュールだけを require できるよう、
 * 型は必要最小限に絞ってある。
 */
export interface AgentIndexEntry {
	name: string;
	displayName?: string;
	sessionId?: string;
	workDir?: string;
	parentAgent?: string;
}

/** ライブ表示用モデル（CSM AgentInfo とのジョイン結果） */
export interface LiveAgentView {
	entry: ClaudeAgentEntry;
	/** CSM 登録エージェント名（マッチした場合） */
	linkedAgentName?: string;
	/** CSM 登録エージェントの表示名 */
	linkedDisplayName?: string;
	/**
	 * マッチの確度。
	 * v0.5.24 で 'cwd' 推測マッチングを撤去した（同一 workDir 共有時の誤紐付けが実害を出したため）。
	 * 現行の値は 'session-id'（本物の sessionId 紐付け）または 'none'（未紐付け）のみ。
	 * 'cwd' は互換のため型に残置するが、buildLiveAgentViews からは決して返らない。
	 */
	matchLevel: 'session-id' | 'cwd' | 'none';
}

// -------------------------------------------------------------------
// v0.5.24: ライブ状態ツリー化（agentLiveTreeProvider から純ロジックを分離）
// -------------------------------------------------------------------

/**
 * ライブツリーのエージェントグループ（本物紐付けあり）。
 * 1 つのエージェントに対して同時に複数セッションが動いている状態（例: 別窓・別ワークツリー）
 * を明示的に表現するため、`sessions` は配列。
 */
export interface LiveAgentGroup {
	/** CSM 登録エージェント名（必ずセット、これがグループ ID） */
	linkedAgentName: string;
	/** CSM エージェント表示名（`displayName || name`） */
	linkedDisplayName: string;
	/** そのエージェントに紐付いている稼働セッションの一覧（`matchLevel==='session-id'` のみ） */
	sessions: LiveAgentView[];
	/** そのエージェントの直下（agents/*.md の parentAgent === linkedAgentName）数（部門長判定用） */
	subordinateAgentCount: number;
}

/**
 * ツリー全体の構造。
 * - `agents`: 本物紐付けで稼働セッションを持つエージェントのグループ（稼働ゼロは含まない）。
 * - `undefined`: 本物紐付けの無い稼働セッション（『未定義（N）』グループ配下に並ぶ）。
 */
export interface LiveTreeStructure {
	agents: LiveAgentGroup[];
	undefined: LiveAgentView[];
}

/**
 * v0.5.24: `ClaudeAgentEntry[] × AgentIndexEntry[] → LiveAgentView[]` の純関数。
 *
 * **cwd 推測マッチングは撤去済み**（同一 workDir 共有時の誤紐付けが実害を出したため）。
 * 詳細な設計判断は `agentLiveTreeProvider.ts` の `buildLiveAgentViews` 側コメント参照。
 * 本モジュールに配置している理由: vscode モジュール非依存で単体テスト可能にするため。
 */
export function resolveLiveAgentViews(
	entries: ClaudeAgentEntry[],
	agents: readonly AgentIndexEntry[],
): LiveAgentView[] {
	const sidMap = new Map<string, AgentIndexEntry>();
	for (const a of agents) {
		if (a.sessionId) { sidMap.set(a.sessionId, a); }
	}
	return entries.map((entry) => {
		if (entry.sessionId) {
			const matched = sidMap.get(entry.sessionId);
			if (matched) {
				return {
					entry,
					linkedAgentName: matched.name,
					linkedDisplayName: matched.displayName || matched.name,
					matchLevel: 'session-id' as const,
				};
			}
		}
		return { entry, matchLevel: 'none' as const };
	});
}

/**
 * v0.5.24: ライブビューをエージェント別 2 階層にグルーピングする純関数。
 *
 * 設計要点:
 * - **cwd 推測マッチングは前段の buildLiveAgentViews で撤去済み**。ここに来る views は
 *   `matchLevel === 'session-id'` か `'none'` のいずれか。本関数では `linkedAgentName` の
 *   有無だけを見てグループ振り分けする。
 * - 稼働ゼロのエージェント（`matchLevel==='session-id'` のセッションを 1 件も持たないエージェント）
 *   は `agents` に含めない — ライブ状態タブは「今動いているもの」だけを見せる。
 * - `undefined` は cwd 推測を経由しないため、通常チャットの N 本が誤って部門長に貼り付く現象は根絶。
 *
 * @param views       buildLiveAgentViews の戻り値
 * @param agentsIndex 全エージェント（parentAgent 関係で subordinateAgentCount を計算）
 * @returns 2 階層構造
 */
export function buildLiveTreeStructure(
	views: LiveAgentView[],
	agentsIndex: readonly AgentIndexEntry[],
): LiveTreeStructure {
	// parentAgent === X の子供数を数える（部門長判定用）
	const childCount = new Map<string, number>();
	for (const a of agentsIndex) {
		if (a.parentAgent) {
			childCount.set(a.parentAgent, (childCount.get(a.parentAgent) ?? 0) + 1);
		}
	}

	const groupMap = new Map<string, LiveAgentGroup>();
	const undef: LiveAgentView[] = [];

	for (const v of views) {
		if (v.matchLevel === 'session-id' && v.linkedAgentName) {
			let g = groupMap.get(v.linkedAgentName);
			if (!g) {
				g = {
					linkedAgentName: v.linkedAgentName,
					linkedDisplayName: v.linkedDisplayName || v.linkedAgentName,
					sessions: [],
					subordinateAgentCount: childCount.get(v.linkedAgentName) ?? 0,
				};
				groupMap.set(v.linkedAgentName, g);
			}
			g.sessions.push(v);
		} else {
			// linkedAgentName が無い、または（互換上ありえないが）'cwd' 推測が来た場合も未定義行へ。
			undef.push(v);
		}
	}

	// エージェント名で安定ソート
	const agents = [...groupMap.values()].sort((a, b) =>
		a.linkedDisplayName.localeCompare(b.linkedDisplayName, 'ja'),
	);

	return { agents, undefined: undef };
}

/** 秒数を "HH:MM:SS" 形式に変換 */
export function formatElapsed(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * v0.5.22 レビュー修正 L3: sessions/*.json（`~/.claude/sessions/<pid>.json`）から
 *   agentWatcher が収集するリッチメタの共通型。従来 agentWatcher.ts に 3 か所複製されていた
 *   匿名 shape を一本化する。types.ts の SessionMeta（旧・死に型）もこの構造に一致させる。
 *
 * 例（CC 2.1.207 実物）:
 *   { pid, sessionId, cwd, startedAt, version:"2.1.207", peerProtocol:1,
 *     kind:"interactive", entrypoint:"claude-vscode", name:"xampp-07", nameSource:"derived" }
 */
export interface SessionJsonMeta {
	kind?: string;
	entrypoint?: string;
	version?: string;
	name?: string;
	nameSource?: string;
	agent?: string;
	pid?: number;
	/** v0.5.22 レビュー修正 M2: セッション開始時刻（Unix ms）。orchestration の経過秒計算に使用。 */
	startedAt?: number;
}
