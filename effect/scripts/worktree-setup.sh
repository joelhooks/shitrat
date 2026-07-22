#!/bin/bash

# install dependencies
direnv allow
corepack install
pnpm install

# setup repositories
git clone --branch main https://github.com/effect-ts/effect.git .repos/effect-v4
