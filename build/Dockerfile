FROM --platform=linux/amd64 debian:bookworm

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    python3 \
    wget \
    curl \
    p7zip-full \
    binutils-mips-linux-gnu \
    pkgconf \
    jq \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Install Emscripten SDK 3.1.74 (pinned to match EmulatorJS)
RUN git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && cd /opt/emsdk \
    && ./emsdk install 3.1.74 \
    && ./emsdk activate 3.1.74

# Activate emsdk in all shells
ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/emsdk/node/18.20.3_64bit/bin:${PATH}"
ENV EMSDK=/opt/emsdk
ENV EM_CONFIG=/opt/emsdk/.emscripten

WORKDIR /build
