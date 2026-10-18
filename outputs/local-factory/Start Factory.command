#!/bin/zsh
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
node factory.mjs
factory_exit=$?
if [[ $factory_exit -ne 0 ]]; then
  echo "Factory stopped with an error. The message above explains why."
  read "?Press Return to close."
fi
