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
    --bg: #0b0c0e; --line: #1e2126; --text: #d6d9de; --dim: #767c86; --tool: #7aa2f7;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    position: sticky; top: 0; background: rgba(11,12,14,.94); border-bottom: 1px solid var(--line);
    padding: 8px 14px; display: flex; align-items: center; gap: 12px;
  }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .04em; }
  nav a { color: var(--dim); text-decoration: none; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 96px; }
  h2 { font-size: 13px; margin: 28px 0 8px; }
  p, li { color: #aeb4bd; }
  code, pre { background: #101318; border-radius: 3px; padding: 1px 5px; }
  pre { padding: 10px 12px; overflow-x: auto; border-left: 2px solid var(--line); }
  .button {
    display: inline-block; background: #1a2740; color: var(--text); border: 1px solid #2c4370;
    border-radius: 6px; padding: 10px 18px; text-decoration: none; margin: 10px 0;
  }
  .button:hover { background: #21324f; }
  .dim { color: var(--dim); }
</style>
<header><h1>AGENT</h1><nav><a href="/">activity</a></nav></header>
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
