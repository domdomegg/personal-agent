# A small Linux box for the agent to live in.
#
# Deliberately a general-purpose sandbox rather than a minimal single-process
# image: the agent edits its own repo and runs git, gh and kubectl, and Adam
# gets a shell with `kubectl exec` to authenticate Claude Code and poke at
# things. So it carries the usual tools and a real home on a persistent volume.
FROM node:22-bookworm-slim

# git: the agent commits and pushes its own repo.
# ripgrep/jq/less/procps: what Claude Code reaches for constantly.
# bash: `kubectl exec -it ... -- bash` is how you get a shell in here.
# fontconfig/unzip: chart rendering (sharp/librsvg needs fontconfig to find
# fonts); reinstalling them from a shell was lost on every pod restart.
RUN apt-get update && apt-get install -y --no-install-recommends \
	bash ca-certificates curl fontconfig git gnupg jq less procps ripgrep unzip \
	&& rm -rf /var/lib/apt/lists/*

# Source Sans 3, the house font for charts the agent sends.
RUN curl -fsSLo /tmp/ss3.zip https://github.com/adobe-fonts/source-sans/releases/download/3.052R/OTF-source-sans-3.052R.zip \
	&& unzip -q /tmp/ss3.zip -d /tmp/ss3 \
	&& mkdir -p /usr/local/share/fonts \
	&& cp /tmp/ss3/OTF/*.otf /usr/local/share/fonts/ \
	&& fc-cache -f \
	&& rm -rf /tmp/ss3 /tmp/ss3.zip

# A desktop the agent can drive and Adam can watch: a virtual X display (xvfb)
# with a bare window manager, Chromium, the tools Bash uses to drive it
# (xdotool, scrot), and x11vnc + noVNC so the screen is viewable in a browser
# behind the cluster's auth. Chromium runs as the unprivileged `desktop` user
# and keeps its own namespace sandbox (the pod allows unprivileged userns, so
# no --no-sandbox); the agent's credentials live under /home/agent and a
# browser must not be able to read them. See scripts/desktop/.
# xterm (+ fonts, since the slim base ships none X can use) gives Adam a root
# shell on that screen — see scripts/desktop/desktop-terminal for the trade-off.
RUN apt-get update && apt-get install -y --no-install-recommends \
	chromium fonts-dejavu-core novnc openbox scrot websockify x11vnc xdotool xfonts-base xterm xvfb \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --create-home --uid 1001 --shell /bin/bash desktop
COPY scripts/desktop/desktop-start scripts/desktop/desktop-chromium scripts/desktop/desktop-terminal /usr/local/bin/
ENV DISPLAY=:1

# GitHub CLI, for the agent's own PRs.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# kubectl, so the agent can look at the cluster it runs on.
RUN curl -fsSLo /usr/local/bin/kubectl \
		"https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" \
	&& chmod +x /usr/local/bin/kubectl

RUN npm install -g @anthropic-ai/claude-code call-mcp && npm cache clean --force

# Runs as root so things can be installed from a shell without a rebuild. This
# is a single-tenant sandbox, not a multi-user host.
ENV HOME=/home/agent
WORKDIR /home/agent

# The image ships no source. /home/agent is a persistent volume holding a git
# checkout the agent edits, commits and pushes — baking a copy in would mean
# two diverging trees, and the agent editing the one that never runs.
# The entrypoint clones it on first boot.
ENV AGENT_REPO=https://github.com/domdomegg/personal-agent.git

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4317
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
