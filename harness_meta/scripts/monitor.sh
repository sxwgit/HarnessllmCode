#!/usr/bin/env bash
#
# Harness 运行监控脚本
# 用法: ./scripts/monitor.sh [间隔秒数]
# 默认每 30 秒检查一次
#

set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$HARNESS_ROOT/.." && pwd)"
STATE_FILE="$HARNESS_ROOT/meta_state.json"
CHECKPOINTS_DIR="$HARNESS_ROOT/checkpoints"
TARGET_DIR="$WORKSPACE_ROOT/target_project"
LOG_DIR="$HARNESS_ROOT/meta_logs"
INTERVAL="${1:-30}"

# 颜色
G='\033[0;32m' R='\033[0;31m' Y='\033[0;33m' C='\033[0;36m' GR='\033[0;90m' B='\033[1m' NC='\033[0m'

echo -e "${B}═══════════════════════════════════════════════${NC}"
echo -e "${B}  Harness Monitor (每 ${INTERVAL}s 检查, Ctrl+C 退出)${NC}"
echo -e "${B}═══════════════════════════════════════════════${NC}"
echo ""

while true; do
  clear
  echo -e "${B}[$(date '+%H:%M:%S')] Harness 状态${NC}"
  echo "─────────────────────────────────────────────"

  # 1. 进程状态
  pid=$(pgrep -f "tsx src/index.ts" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo -e "进程: ${G}● 运行中${NC} (PID ${pid})"
  else
    echo -e "进程: ${R}○ 未运行${NC}"
  fi

  # 2. 状态机（从 meta_state.json 读取）
  if [ -f "$STATE_FILE" ]; then
    current=$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('currentState','?'))" 2>/dev/null || echo "?")
    sprint=$(python3 -c "import json;d=json.load(open('$STATE_FILE'));print(d.get('currentSprintId') or '—')" 2>/dev/null || echo "—")
    errors=$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('errorCount',0))" 2>/dev/null || echo "0")
    completed=$(python3 -c "import json;print(len(json.load(open('$STATE_FILE')).get('completedSprints',[])))" 2>/dev/null || echo "0")
    echo -e "状态: ${B}${current}${NC}  Sprint: ${sprint}  已完成: ${completed}  错误: ${errors}"
  else
    echo -e "状态: ${GR}无状态文件${NC}"
  fi

  # 3. 检查点
  if [ -d "$CHECKPOINTS_DIR" ]; then
    cps=$(ls "$CHECKPOINTS_DIR"/checkpoint_*.json 2>/dev/null || true)
    if [ -n "$cps" ]; then
      count=$(echo "$cps" | wc -l | tr -d ' ')
      names=$(echo "$cps" | while IFS= read -r f; do basename "$f" | sed 's/checkpoint_\(.*\)_[0-9]*\.json/\1/'; done)
      echo -e "检查点: ${G}${count}${NC} (${names//$'\n'/, })"
    else
      echo -e "检查点: ${GR}无${NC}"
    fi
  else
    echo -e "检查点: ${GR}无${NC}"
  fi

  # 4. 设计文档
  if [ -d "$TARGET_DIR/docs/plan" ]; then
    doc_list=$(ls "$TARGET_DIR/docs/plan/"*.md 2>/dev/null || true)
    if [ -n "$doc_list" ]; then
      doc_count=$(echo "$doc_list" | wc -l | tr -d ' ')
      echo -e "设计文档: ${G}${doc_count}${NC}"
    else
      echo -e "设计文档: ${GR}未生成${NC}"
    fi
  else
    echo -e "设计文档: ${GR}未生成${NC}"
  fi

  # 5. Sprint 合同
  if [ -d "$TARGET_DIR/docs/sprint" ]; then
    sc_list=$(ls "$TARGET_DIR/docs/sprint/"*.md 2>/dev/null || true)
    if [ -n "$sc_list" ]; then
      sc_count=$(echo "$sc_list" | wc -l | tr -d ' ')
      echo -e "Sprint合同: ${G}${sc_count}${NC}"
    else
      echo -e "Sprint合同: ${GR}未生成${NC}"
    fi
  else
    echo -e "Sprint合同: ${GR}未生成${NC}"
  fi

  # 6. 源码
  if [ -d "$TARGET_DIR/src" ]; then
    src_n=$(find "$TARGET_DIR/src" -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
    echo -e "源码: ${G}${src_n}${NC} .ts 文件"
  else
    echo -e "源码: ${GR}未生成${NC}"
  fi

  # 7. 最新日志
  latest_log=$(ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest_log" ]; then
    last_line=$(tail -1 "$latest_log" 2>/dev/null || true)
    if [ -n "$last_line" ]; then
      ts=$(echo "$last_line" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('timestamp','?')[:19])" 2>/dev/null || echo "?")
      lv=$(echo "$last_line" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('level','?'))" 2>/dev/null || echo "?")
      msg=$(echo "$last_line" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('message','?')[:80])" 2>/dev/null || echo "?")
      lv_color="$GR"
      [ "$lv" = "ERROR" ] && lv_color="$R"
      [ "$lv" = "WARN" ] && lv_color="$Y"
      [ "$lv" = "INFO" ] && lv_color="$C"
      echo -e "日志: ${lv_color}[${lv}]${NC} ${ts} ${msg}"
    fi
  fi

  echo "─────────────────────────────────────────────"
  echo -e "${GR}下次检查: $(date -v+${INTERVAL}S '+%H:%M:%S' 2>/dev/null || date '+%H:%M:%S')${NC}"

  sleep "$INTERVAL"
done
