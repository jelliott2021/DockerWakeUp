#!/bin/bash

CONFIG_FILE="../config.json"
IDLE_THRESHOLD=$(jq '.idleThreshold' "$CONFIG_FILE")

containers=$(docker ps --format '{{.ID}} {{.Names}}')

for entry in $containers; do
    read -r cid name <<< "$entry"
    last_file="/tmp/last_access_${name}"

    if [ -f "$last_file" ]; then
        last_access=$(cat "$last_file")
    else
        last_access=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$cid")" +%s)
    fi

    now=$(date +%s)
    idle_time=$((now - last_access))

    if [ $idle_time -gt $IDLE_THRESHOLD ]; then
        echo "Stopping idle container: $name (idle ${idle_time}s)"
        docker stop "$cid"
    fi
done
