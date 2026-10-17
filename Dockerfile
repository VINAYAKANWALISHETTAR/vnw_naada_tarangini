# Sangeetha — the website.
#
# This image builds the web app only. The Windows desktop app is NOT built here:
# it needs Electron for win32, which is a different target entirely and is
# produced on Windows by run.bat / setup.bat.
#
# The whole image is small because the server has no runtime dependencies. Every
# module it uses is either a Node built-in or a file in this repository, and
# electron — the only entry in package.json — is a devDependency and is skipped
# by `npm ci --omit=dev`. Nothing from node_modules is required to serve the
# site or to call yt-dlp.

# glibc, not Alpine: the yt-dlp standalone binary is built against glibc, and
# musl is a needless compatibility question for a container this simple.
FROM node:22-bookworm-slim

# ca-certificates is required for TLS out to youtube.com and to the yt-dlp
# release host. Without it every upstream fetch fails with a certificate error
# that looks like a network fault rather than a missing package.
#
# python3 is required because the Linux yt-dlp release asset is a Python zipapp,
# not a self-contained binary: it starts with `#!/usr/bin/env python3` followed
# by the ZIP magic number, so the kernel execs /usr/bin/env, which then cannot
# find python3 in an image that has never had it. That is what failed the build
# with exit 127, and it is worth being precise about: curl was already installed
# and is still the right tool for the download, because yt-resolver.js shells out
# to whatever binary is on PATH and a pip install would hit PEP 668's
# externally-managed-environment on bookworm for no benefit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp resolves the direct audio URL, which is the one thing a browser cannot
# do for itself.
#
# Note the asymmetry that caused this: the *Windows* asset (yt-dlp.exe) really is
# a standalone PyInstaller bundle with Python embedded, which is why setup.bat
# and run.bat install no Python and work. The *Linux* asset is the zipapp above.
# One word — "standalone" — covers two different artifact types.
#
# The trailing `yt-dlp --version` is the check that caught this. Without it the
# image builds and the deploy succeeds, and then every single track fails at
# runtime, because the resolver shells out to yt-dlp for every stream. It costs
# nothing and it is the only reason a missing interpreter is a build error rather
# than a silent outage.
#
# ffmpeg is deliberately absent: the resolver only asks yt-dlp for a URL with
# `-g`, never for a transcode, so no muxing or encoding is performed.
RUN curl -fsSL \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app

# Dependencies are installed before the source is copied so that editing a .js
# file does not invalidate this layer. With --omit=dev this installs nothing,
# which is the point: the server needs no third-party packages.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The source lives in js/; index.html, style.css, the icon and the PWA files sit
# beside it in the project root. Both are needed, and the list is explicit on
# purpose: a missing file here is a site that 404s only once deployed.
COPY index.html style.css sangeeta_icon.png manifest.webmanifest sw.js ./
COPY js/server.js js/app-server.js js/api.js js/static-server.js \
     js/logger.js js/yt-proxy.js js/yt-resolver.js js/ytmusic.js \
     js/main.js js/build-info.js \
     js/

# The seven local covers for the default library. They have to be in the image:
# the whole point of shipping them is that the default library still has artwork
# when i.ytimg.com is unreachable, and a container without them silently falls
# back to the remote host it was meant not to need. About 1.3 MB.
# Named individually to mirror PUBLIC_FILES in js/app-server.js, which 404s
# anything it does not list.
COPY assets/covers/f2vB9CLbqIc.jpg assets/covers/x9VXlf0j980.jpg \
     assets/covers/0NAJX4DrXv0.jpg assets/covers/CUdJ-n2l1Hk.jpg \
     assets/covers/pUK8-1JtC0M.jpg assets/covers/DeV43VUG1aY.jpg \
     assets/covers/Y_tzn4vM3ks.jpg \
     assets/covers/

# The cache is written to /tmp, which is writable and ephemeral. A container
# filesystem does not survive a replacement, so a warm cache only ever lives as
# long as the machine — server.js treats a missing cache as normal.
ENV NODE_ENV=production \
    PORT=8080 \
    SANGEETHA_CACHE_DIR=/tmp/sangeetha-cache

# Not a documentation comment: the app refuses to start if it is not reachable
# on this address. server.js binds 0.0.0.0 and honours PORT, and fly.toml's
# internal_port has to match.
EXPOSE 8080

USER node

# The health check is the same endpoint Fly's own checks use, so a container that
# passes here is the container Fly will route traffic to. Binding to 127.0.0.1
# instead of 0.0.0.0 is the single most common cause of a Fly "Host Error":
# the process is healthy and the port is right, but nothing can reach it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

# js/server.js, not server.js. The source is copied into js/ above and nothing
# puts a server.js in /app, so the shorter path exits with MODULE_NOT_FOUND the
# moment the container starts — which looks like a Fly deploy failure rather
# than a typo. It matches `npm run web`, which is the same entrypoint.
CMD ["node", "js/server.js"]
