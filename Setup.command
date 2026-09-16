#!/bin/sh
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sh ./install.sh
result=$?
printf '\nPress Return to close this window. '
read answer
exit "$result"
