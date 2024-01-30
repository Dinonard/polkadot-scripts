#!/bin/bash

command=$1
max_retries=5

for i in $(seq 1 $max_retries)
do
  $command && break || sleep 30
done