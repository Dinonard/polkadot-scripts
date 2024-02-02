#!/bin/bash

command=$1
max_retries=10

for i in $(seq 1 $max_retries)
do
  $command && break || sleep 60
done