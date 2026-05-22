MONACO_VERSION ?= 0.55.1

.PHONY: vendor run build clean

# Download Monaco's prebuilt AMD distribution into public/vs/.
# Uses `npm pack` so no node_modules is left behind.
vendor:
	npm pack monaco-editor@$(MONACO_VERSION)
	tar -xzf monaco-editor-$(MONACO_VERSION).tgz
	rm -rf public/vs
	mkdir -p public
	mv package/min/vs public/vs
	rm -rf package monaco-editor-$(MONACO_VERSION).tgz
	@echo "Monaco $(MONACO_VERSION) vendored into public/vs/"

run:
	go run .

build:
	go build -o monaco-editor .

clean:
	rm -rf public monaco-editor monaco-editor-*.tgz package
