// 端末がオフラインか、エラーが「ノードに届かなかった」ものか、の判定。依存が無いので、どこからでも読める（単体テストもできる）。

/** 端末がオフライン（機内モード、ネットワークの切断、ブラウザのオフライン設定）か。 */
export function isDeviceOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * ノードに届かなかった（回線が無い・ノードが全部応答しない・タイムアウト）エラーか。
 * ノードが答えた失敗（HTTP の 4xx / 5xx、トランザクションの拒否）は含めない。
 */
export function isNetworkFailure(e: unknown): boolean {
  if (e === null || e === undefined) return false;
  const status = (e as { status?: unknown }).status;
  if (typeof status === 'number') return false;
  if (e instanceof TypeError) return true;
  const name = (e as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = e instanceof Error ? e.message : String(e);
  return /no_node_available|^offline$|failed to fetch|networkerror|network request failed|load failed|aborted|timed out/i.test(message);
}
