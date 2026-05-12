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
	@pkill -f "tsx watch src/index" 2>/dev/null || true
	@pkill -f "esbuild.*watch=forever" 2>/dev/null || true
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@echo "stopped"

utest:
	npm run utest

itest:
	npm run itest
