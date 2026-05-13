.PHONY: install clean build dev stop utest itest

install:
	npm install

clean:
	rm -rf dist dashboard/main.js

build: install
	npm run build

dev:
	npm run dev:dashboard-watch & npm run dev; kill %1 2>/dev/null || true

stop:
	@pgrep -f "tsx watch src/index" | xargs -r kill 2>/dev/null || true
	@pgrep -f "esbuild.*watch"      | xargs -r kill 2>/dev/null || true
	@lsof -ti:3000                  | xargs -r kill 2>/dev/null || true
	@sleep 1
	@lsof -ti:3000 | xargs -r kill -9 2>/dev/null || true
	@lsof -ti:3000 >/dev/null 2>&1 && echo "warning: port 3000 still in use" || echo "stopped"

utest:
	npm run utest

itest:
	npm run itest
