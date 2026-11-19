/**
 * /connect: how to open this machine in VS Code.
 *
 * The cheap route, not an embedded editor: VS Code attaches into the already-
 * running agent pod via the user's own kubectl creds, so there is no standing
 * RAM cost on the node (vscode-server runs in the pod only while attached).
 */
export function connectPage(options: {podName: string; namespace: string; container: string}): string {
	const {podName, namespace, container} = options;
	// The remote authority VS Code's Kubernetes extension registers for
	// attached containers. If the deeplink does nothing, the manual steps
	// below do the same thing through the UI.
	const authority = `k8s-container+context=default+namespace=${namespace}+podname=${podName}+name=${container}`;
	const deeplink = `vscode://vscode-remote/${authority}/home/agent/src`;

	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent · connect</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101113; --line: #22242a; --text: #e6e8ec; --dim: #8b9099; --them: #1c1e23; --accent: #4f8cff;
    --code-bg: #101318; --code-text: #aeb4bd;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f6f7f9; --line: #e3e5ea; --text: #1b1d22; --dim: #6f7580; --them: #ffffff; --accent: #2f6fde;
      --code-bg: #eef0f4; --code-text: #30343b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--font); }
  header {
    position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
    padding: 8px max(14px, calc((100% - 820px) / 2 + 14px)); display: flex; align-items: center; gap: 10px;
  }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .04em; }
  nav { display: flex; gap: 2px; margin-left: auto; }
  nav a { color: var(--dim); text-decoration: none; padding: 4px 8px; border-radius: 6px; font-size: 13px; }
  nav a:hover { color: var(--text); }
  nav a.active { color: var(--text); background: var(--them); }
  main { max-width: 820px; margin: 0 auto; padding: 20px 14px 96px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  p, li { color: var(--dim); }
  li { margin: 4px 0; }
  b { color: var(--text); font-weight: 600; }
  code, pre { font: 13px/1.5 var(--mono); background: var(--code-bg); color: var(--code-text); border-radius: 4px; padding: 1px 5px; }
  pre { padding: 10px 12px; overflow-x: auto; border-left: 2px solid var(--line); }
  .button {
    display: inline-block; background: var(--accent); color: #fff; border: 0;
    border-radius: 999px; padding: 10px 18px; text-decoration: none; margin: 10px 0; font-weight: 600;
  }
  .button:hover { filter: brightness(1.08); }
  .dim { color: var(--dim); font-size: 13px; }
</style>
<header><h1>AGENT</h1><nav><a href="/">chat</a> <a href="/desktop" target="_blank">desktop</a> <a class="active" href="/connect">connect</a></nav></header>
<main>
  <h2>Open this machine in VS Code</h2>
  <p>Files live in <code>/home/agent/src</code> in the pod
    <code>${podName}</code> (namespace <code>${namespace}</code>).
    Nothing extra runs on the node until you attach.</p>

  <a class="button" href="${deeplink}">Open in VS Code</a>
  <p class="dim">Needs VS Code with the Kubernetes extension, and kubectl creds
    for the cluster. If the button does nothing, use the steps below.</p>

  <h2>Manual steps</h2>
  <ol>
    <li>Install the <b>Kubernetes</b> extension
      (<code>ms-kubernetes-tools.vscode-kubernetes-tools</code>) and
      <b>Dev Containers</b> in VS Code.</li>
    <li>Make sure <code>kubectl get pods</code> works against the cluster.</li>
    <li>In the Kubernetes sidebar: cluster → Workloads → Pods →
      <code>${podName}</code> → right-click →
      <b>Attach Visual Studio Code</b>.</li>
    <li>Once attached: File → Open Folder → <code>/home/agent/src</code>.</li>
  </ol>

  <h2>Terminal-only alternative</h2>
  <pre>kubectl exec -it ${podName} -c ${container} -- bash</pre>
</main>
</html>`;
}
