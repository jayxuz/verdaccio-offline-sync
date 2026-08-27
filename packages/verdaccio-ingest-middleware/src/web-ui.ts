/**
 * Web UI HTML 模板
 * 提供简单的管理界面用于触发功能和查看日志
 */

export function getWebUIHTML(config: any): string {
  const title = config?.title || 'Verdaccio Offline Sync';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 管理界面</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f5f5;
      color: #333;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      background: linear-gradient(135deg, #4a90a4 0%, #2c5364 100%);
      color: white;
      padding: 20px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }

    header h1 {
      font-size: 24px;
      margin-bottom: 5px;
    }

    header p {
      opacity: 0.9;
      font-size: 14px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }

    .container > .card {
      margin-bottom: 20px;
    }

    .container > .card:last-child {
      margin-bottom: 0;
    }

    .card h2 {
      font-size: 18px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #4a90a4;
      color: #2c5364;
    }

    .btn {
      display: inline-block;
      padding: 10px 20px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
      margin: 5px;
    }

    .btn-primary {
      background: #4a90a4;
      color: white;
    }

    .btn-primary:hover {
      background: #3a7a94;
    }

    .btn-success {
      background: #28a745;
      color: white;
    }

    .btn-success:hover {
      background: #218838;
    }

    .btn-warning {
      background: #ffc107;
      color: #333;
    }

    .btn-warning:hover {
      background: #e0a800;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .form-group {
      margin-bottom: 15px;
    }

    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
      color: #555;
    }

    .form-group input,
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 14px;
    }

    .form-group textarea {
      min-height: 80px;
      resize: vertical;
    }

    .checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .checkbox-group label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: normal;
      cursor: pointer;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 6px;
      border: 1px solid #e9ecef;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .checkbox-group label:hover {
      background: #e9ecef;
      border-color: #4a90a4;
    }

    .checkbox-group input[type="checkbox"]:checked + span,
    .checkbox-group label:has(input:checked) {
      background: #e3f2fd;
      border-color: #4a90a4;
    }

    .option-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #f8f9fa;
      border-radius: 6px;
      border: 1px solid #e9ecef;
      margin-bottom: 10px;
    }

    .option-row:hover {
      background: #e9ecef;
    }

    .option-row label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-weight: normal;
      white-space: nowrap;
    }

    .help-btn {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #6c757d;
      color: white;
      border: none;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      position: relative;
    }

    .help-btn:hover {
      background: #4a90a4;
    }

    .tooltip {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: normal;
      min-width: 200px;
      max-width: 400px;
      white-space: normal;
      text-align: left;
      z-index: 1000;
      margin-bottom: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      display: none;
    }

    .tooltip::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-top-color: #333;
    }

    .help-btn:hover .tooltip {
      display: block;
    }

    .log-container {
      background: #1e1e1e;
      color: #d4d4d4;
      border-radius: 5px;
      padding: 15px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      max-height: 400px;
      overflow-y: auto;
    }

    .log-entry {
      margin-bottom: 5px;
      padding: 3px 0;
      border-bottom: 1px solid #333;
    }

    .log-entry.info { color: #4fc3f7; }
    .log-entry.success { color: #81c784; }
    .log-entry.warning { color: #ffb74d; }
    .log-entry.error { color: #e57373; }

    .log-time {
      color: #888;
      margin-right: 10px;
    }

    .status-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-badge.running { background: #e3f2fd; color: #1976d2; }
    .status-badge.completed { background: #e8f5e9; color: #388e3c; }
    .status-badge.failed { background: #ffebee; color: #d32f2f; }
    .status-badge.pending { background: #fff3e0; color: #f57c00; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin-bottom: 15px;
    }

    .stat-item {
      text-align: center;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 5px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #4a90a4;
    }

    .stat-label {
      font-size: 12px;
      color: #666;
      margin-top: 5px;
    }

    .progress-bar {
      height: 8px;
      background: #e0e0e0;
      border-radius: 4px;
      overflow: hidden;
      margin: 10px 0;
    }

    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #4a90a4, #28a745);
      transition: width 0.3s;
    }

    .package-list {
      max-height: 300px;
      overflow-y: auto;
    }

    .package-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid #eee;
    }

    .package-item:hover {
      background: #f8f9fa;
    }

    .package-name {
      font-weight: 500;
    }

    .package-versions {
      font-size: 12px;
      color: #666;
    }

    .hidden {
      display: none;
    }

    /* 分析结果样式 */
    .analysis-result {
      margin-top: 15px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
      border: 1px solid #e9ecef;
    }

    .analysis-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .analysis-stats {
      display: flex;
      gap: 20px;
    }

    .analysis-stat {
      text-align: center;
    }

    .analysis-stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #4a90a4;
    }

    .analysis-stat-label {
      font-size: 12px;
      color: #666;
    }

    .download-list {
      max-height: 250px;
      overflow-y: auto;
      margin: 15px 0;
      border: 1px solid #ddd;
      border-radius: 5px;
    }

    .download-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid #eee;
      font-size: 13px;
    }

    .download-item:last-child {
      border-bottom: none;
    }

    .download-item.success {
      background: #e8f5e9;
    }

    .download-item.failed {
      background: #ffebee;
    }

    .download-item .pkg-name {
      font-weight: 500;
    }

    .download-item .pkg-version {
      color: #666;
      margin-left: 5px;
    }

    .download-item .pkg-reason {
      font-size: 11px;
      color: #888;
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 3px;
    }

    .download-item .pkg-status {
      font-size: 12px;
    }

    .download-item .pkg-status.success {
      color: #28a745;
    }

    .download-item .pkg-status.failed {
      color: #dc3545;
    }

    .btn-danger {
      background: #dc3545;
      color: white;
    }

    .btn-danger:hover {
      background: #c82333;
    }

    .action-buttons {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }

    /* 详细进度显示样式 */
    .detailed-progress {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 15px;
      margin-top: 15px;
      border: 1px solid #e9ecef;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .progress-phase {
      font-weight: 600;
      color: #2c5364;
    }

    .progress-percentage {
      font-size: 24px;
      font-weight: bold;
      color: #4a90a4;
    }

    .progress-bar-large {
      height: 12px;
      background: #e0e0e0;
      border-radius: 6px;
      overflow: hidden;
      margin: 10px 0;
    }

    .progress-bar-large .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #4a90a4, #28a745);
      transition: width 0.3s;
    }

    .progress-details {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin-top: 15px;
    }

    .progress-detail-item {
      text-align: center;
      padding: 10px;
      background: white;
      border-radius: 6px;
      border: 1px solid #e9ecef;
    }

    .progress-detail-value {
      font-size: 18px;
      font-weight: bold;
      color: #4a90a4;
    }

    .progress-detail-label {
      font-size: 11px;
      color: #666;
      margin-top: 3px;
    }

    .progress-current-pkg {
      margin-top: 10px;
      padding: 8px 12px;
      background: #e3f2fd;
      border-radius: 5px;
      font-size: 13px;
      color: #1976d2;
      word-break: break-all;
    }

    .progress-eta {
      text-align: right;
      font-size: 13px;
      color: #666;
      margin-top: 8px;
    }

    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔄 ${title}</h1>
      <p>离线 NPM 依赖管理 - 外网摄取控制台</p>
    </header>

    <div class="grid">
      <!-- 缓存状态 -->
      <div class="card">
        <h2>📦 缓存状态</h2>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-value" id="totalPackages">-</div>
            <div class="stat-label">总包数</div>
          </div>
          <div class="stat-item">
            <div class="stat-value" id="totalVersions">-</div>
            <div class="stat-label">总版本数</div>
          </div>
          <div class="stat-item">
            <div class="stat-value" id="lastSync">-</div>
            <div class="stat-label">统计更新于</div>
          </div>
        </div>
        <button class="btn btn-primary" onclick="refreshCacheStatus()">
          🔄 刷新状态
        </button>
      </div>

      <!-- 快速操作 -->
      <div class="card">
        <h2>⚡ 快速操作</h2>
        <div style="margin-bottom: 15px;">
          <button class="btn btn-primary" onclick="refreshAllMetadata()">
            📋 刷新所有元数据 (简单)
          </button>
          <button class="btn btn-success" onclick="showSyncDialog()">
            🚀 同步缺失依赖
          </button>
          <button class="btn btn-warning" onclick="rebuildIndex()">
            🔧 重建本地索引
          </button>
        </div>
        <div id="quickTaskStatus" class="hidden">
          <div class="progress-bar">
            <div class="progress-bar-fill" id="quickProgress" style="width: 0%"></div>
          </div>
          <p id="quickMessage" style="font-size: 13px; color: #666;"></p>
        </div>
      </div>
    </div>

    <!-- 元数据同步 -->
    <div class="card">
      <h2>📋 元数据同步</h2>
      <p style="color: #666; margin-bottom: 15px; font-size: 13px;">
        同步并修复本地存储中所有包的元数据（package.json），确保版本信息、dist-tags 等数据完整正确。
      </p>
      <div style="margin-bottom: 15px;">
        <button class="btn btn-primary" onclick="startSyncAll()" id="syncAllBtn">
          🔄 同步所有包元数据
        </button>
        <button class="btn btn-success" onclick="loadPackageList()" id="loadPkgListBtn">
          📦 查看包列表
        </button>
      </div>
      <div class="form-group">
        <label>单包同步</label>
        <div style="display: flex; gap: 10px;">
          <input type="text" id="syncPackageName" placeholder="输入包名，如 lodash 或 @types/node" style="flex: 1;">
          <button class="btn btn-primary" onclick="syncSinglePackage()">同步</button>
        </div>
      </div>
      <!-- 同步进度 -->
      <div id="syncProgress" class="detailed-progress hidden">
        <div class="progress-header">
          <span class="progress-phase" id="syncPhase">准备中...</span>
          <span class="progress-percentage" id="syncPercentage">0%</span>
        </div>
        <div class="progress-bar-large">
          <div class="progress-bar-fill" id="syncProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-details">
          <div class="progress-detail-item">
            <div class="progress-detail-value" id="syncProcessed">0</div>
            <div class="progress-detail-label">已处理</div>
          </div>
          <div class="progress-detail-item">
            <div class="progress-detail-value" id="syncTotal">0</div>
            <div class="progress-detail-label">总数</div>
          </div>
          <div class="progress-detail-item">
            <div class="progress-detail-value" id="syncFailed">0</div>
            <div class="progress-detail-label">失败</div>
          </div>
        </div>
        <div class="progress-current-pkg" id="syncCurrentPkg">等待开始...</div>
      </div>
      <!-- 同步结果 -->
      <div id="syncResult" class="analysis-result hidden">
        <div class="analysis-header">
          <h3 style="margin: 0; color: #2c5364;">同步结果</h3>
          <div class="analysis-stats">
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="syncResultTotal">0</div>
              <div class="analysis-stat-label">总数</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="syncResultSuccess">0</div>
              <div class="analysis-stat-label">成功</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="syncResultFailed">0</div>
              <div class="analysis-stat-label">失败</div>
            </div>
          </div>
        </div>
      </div>
      <!-- 包列表 -->
      <div id="syncPackageList" class="hidden" style="margin-top: 15px;">
        <h3 style="margin-bottom: 10px; color: #2c5364;">本地包列表 <button class="btn btn-warning" onclick="hidePackageList()" style="padding: 3px 10px; font-size: 12px;">关闭</button></h3>
        <div class="package-list" id="syncPkgListContainer">
          <p style="color: #666; text-align: center; padding: 20px;">加载中...</p>
        </div>
      </div>
    </div>

    <!-- 完整性检查与修复 -->
    <div class="card" id="repairCard">
      <h2>🩹 完整性检查与修复</h2>
      <p style="color: #666; margin-bottom: 15px; font-size: 13px;">
        扫描"有元数据（package.json）但没有任何 tarball"的残缺包并补下载。
        修复完成后，如需这些包的可选依赖/对等依赖（含 Linux x64、Windows x64 平台二进制），
        再执行一次下方「同步配置」的分析下载即可（勾选"包含可选依赖、包含对等依赖"）。
      </p>
      <div class="form-group">
        <label>下载范围</label>
        <div class="option-row">
          <label><input type="radio" name="repairVersionScope" value="latest" checked><span>仅最新版本</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">每个残缺包只下载 dist-tags.latest 指向的版本，量最小、速度最快（推荐）</span></button>
        </div>
        <div class="option-row">
          <label><input type="radio" name="repairVersionScope" value="smart"><span>智能模式</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">latest + 每个大版本的最新版 + 被本地其他包依赖范围命中的版本。更完整但下载量可能大很多</span></button>
        </div>
      </div>
      <div style="margin-bottom: 15px;">
        <button class="btn btn-primary" onclick="startRepairScan()" id="repairScanBtn">
          🔍 开始扫描
        </button>
      </div>

      <!-- 扫描进度 -->
      <div id="repairScanProgress" class="detailed-progress hidden">
        <div class="progress-header">
          <span class="progress-phase" id="repairScanPhase">准备中...</span>
          <span class="progress-percentage" id="repairScanPercentage">0%</span>
        </div>
        <div class="progress-bar-large">
          <div class="progress-bar-fill" id="repairScanProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-details">
          <div class="progress-detail-item">
            <div class="progress-detail-value" id="repairScanProcessed">0</div>
            <div class="progress-detail-label">已处理</div>
          </div>
          <div class="progress-detail-item">
            <div class="progress-detail-value" id="repairScanTotal">0</div>
            <div class="progress-detail-label">总数</div>
          </div>
          <div class="progress-detail-item">
            <div class="progress-detail-value" id="repairScanETA">--</div>
            <div class="progress-detail-label">预计剩余</div>
          </div>
        </div>
        <div class="progress-current-pkg" id="repairScanCurrentPkg">等待开始...</div>
      </div>

      <!-- 扫描预览 -->
      <div id="repairPreview" class="analysis-result hidden">
        <div class="analysis-header">
          <h3 style="margin: 0; color: #2c5364;">扫描结果 <span id="repairScopeLabel" style="font-size: 13px; color: #666;"></span></h3>
          <div class="analysis-stats">
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairIncompleteCount">0</div>
              <div class="analysis-stat-label">残缺包</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairVersionsToDownload">0</div>
              <div class="analysis-stat-label">待下载版本</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairUnrepairableCount">0</div>
              <div class="analysis-stat-label">无法修复</div>
            </div>
          </div>
        </div>
        <div class="download-list" id="repairPlanList"></div>
        <div id="repairUnrepairableList" style="margin-top: 10px;"></div>
        <div class="action-buttons">
          <button class="btn btn-success" onclick="confirmRepair()" id="repairConfirmBtn">
            ✅ 确认修复
          </button>
          <button class="btn btn-warning" onclick="cancelRepair()">
            ❌ 取消
          </button>
        </div>
      </div>

      <!-- 修复进度 -->
      <div id="repairProgress" class="detailed-progress hidden">
        <div class="progress-header">
          <span class="progress-phase" id="repairPhase">下载中...</span>
          <span class="progress-percentage" id="repairPercentage">0%</span>
        </div>
        <div class="progress-bar-large">
          <div class="progress-bar-fill" id="repairProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-current-pkg" id="repairCurrentPkg">等待开始...</div>
      </div>

      <!-- 修复结果 -->
      <div id="repairResult" class="analysis-result hidden">
        <div class="analysis-header">
          <h3 style="margin: 0; color: #2c5364;">修复结果</h3>
          <div class="analysis-stats">
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairRepairedPackages">0</div>
              <div class="analysis-stat-label">修复包数</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairSucceeded">0</div>
              <div class="analysis-stat-label">成功版本</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairFailed">0</div>
              <div class="analysis-stat-label">失败版本</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="repairUpstreamMissing">0</div>
              <div class="analysis-stat-label">上游已下架</div>
            </div>
          </div>
        </div>
        <div class="download-list" id="repairFailedList"></div>
        <div class="action-buttons" id="repairRetryActions">
          <button class="btn btn-warning" onclick="retryRepairFailed()" id="repairRetryBtn">
            🔄 重试失败项
          </button>
          <button class="btn btn-primary" onclick="resetRepairWorkflow()">
            ↩️ 返回
          </button>
        </div>
      </div>
    </div>

    <div class="grid">
      <!-- 同步配置 -->
      <div class="card" id="syncDialog">
        <h2>🔧 同步配置</h2>
        <div class="form-group">
          <label>目标平台</label>
          <div class="checkbox-group">
            <label><input type="checkbox" name="platform" value="linux-x64" checked><span>Linux x64</span></label>
            <label><input type="checkbox" name="platform" value="linux-arm64"><span>Linux ARM64</span></label>
            <label><input type="checkbox" name="platform" value="win32-x64" checked><span>Windows x64</span></label>
            <label><input type="checkbox" name="platform" value="win32-arm64"><span>Windows ARM64</span></label>
            <label><input type="checkbox" name="platform" value="darwin-x64"><span>macOS x64</span></label>
            <label><input type="checkbox" name="platform" value="darwin-arm64"><span>macOS ARM64</span></label>
          </div>
        </div>
        <div class="form-group">
          <label>同步选项</label>
          <div class="option-row">
            <label><input type="checkbox" id="refreshAllMetadataBeforeAnalyze"><span>分析前全量刷新元数据</span></label>
            <button class="help-btn" type="button">?<span class="tooltip">默认关闭。开启后会先从上游刷新所有本地缓存包的元数据，可能耗时较长并显著增加元数据体积</span></button>
          </div>
          <div class="option-row">
            <label><input type="checkbox" id="updateToLatest"><span>更新到最新版本</span></label>
            <button class="help-btn" type="button">?<span class="tooltip">检查已缓存包是否有更新版本，如有则下载最新版本到本地缓存</span></button>
          </div>
          <div class="option-row">
            <label><input type="checkbox" id="includeOptional" checked><span>包含可选依赖</span></label>
            <button class="help-btn" type="button">?<span class="tooltip">下载 optionalDependencies 中的包，包括平台特定的二进制包（如 @esbuild/linux-x64）</span></button>
          </div>
          <div class="option-row">
            <label><input type="checkbox" id="includePeer" checked><span>包含对等依赖</span></label>
            <button class="help-btn" type="button">?<span class="tooltip">下载 peerDependencies 中声明的包，这些是运行时需要的依赖</span></button>
          </div>
          <div class="option-row">
            <label><input type="checkbox" id="completeSiblingVersions"><span>补全同级版本</span></label>
            <button class="help-btn" type="button">?<span class="tooltip">对每个已缓存的版本，自动下载同 minor 系列的最新 patch 版本和同 major 系列的最新 minor 版本。例如本地有 6.3.2，则补全 6.3.x 最新和 6.x.x 最新</span></button>
          </div>
        </div>
        <button class="btn btn-primary" onclick="startAnalysis()" id="analyzeBtn">
          🔍 分析依赖
        </button>


        <!-- 分析进度区域 -->
        <div id="analysisProgress" class="detailed-progress hidden">
          <div class="progress-header">
            <span class="progress-phase" id="progressPhase">准备中...</span>
            <span class="progress-percentage" id="progressPercentage">0%</span>
          </div>
          <div class="progress-bar-large">
            <div class="progress-bar-fill" id="analysisProgressBar" style="width: 0%"></div>
          </div>
          <div class="progress-details">
            <div class="progress-detail-item">
              <div class="progress-detail-value" id="progressProcessed">0</div>
              <div class="progress-detail-label">已处理</div>
            </div>
            <div class="progress-detail-item">
              <div class="progress-detail-value" id="progressTotal">0</div>
              <div class="progress-detail-label">总数</div>
            </div>
            <div class="progress-detail-item">
              <div class="progress-detail-value" id="progressETA">--</div>
              <div class="progress-detail-label">预计剩余</div>
            </div>
          </div>
          <div class="progress-current-pkg" id="progressCurrentPkg">等待开始...</div>
        </div>
        <!-- 分析结果区域 -->
        <div id="analysisResult" class="analysis-result hidden">
          <div class="analysis-header">
            <h3 style="margin: 0; color: #2c5364;">分析结果</h3>
            <div class="analysis-stats">
              <div class="analysis-stat">
                <div class="analysis-stat-value" id="analysisScanned">0</div>
                <div class="analysis-stat-label">已扫描</div>
              </div>
              <div class="analysis-stat">
                <div class="analysis-stat-value" id="analysisToDownload">0</div>
                <div class="analysis-stat-label">待下载</div>
              </div>
            </div>
          </div>
          <div class="download-list" id="downloadList"></div>
          <div class="action-buttons">
            <button class="btn btn-success" onclick="confirmDownload()" id="downloadBtn">
              ✅ 确认下载
            </button>
            <button class="btn btn-warning" onclick="cancelAnalysis()">
              ❌ 取消
            </button>
          </div>
        </div>

        <!-- 下载结果区域 -->
        <div id="downloadResult" class="analysis-result hidden">
          <div class="analysis-header">
            <h3 style="margin: 0; color: #2c5364;">下载结果</h3>
            <div class="analysis-stats">
              <div class="analysis-stat">
                <div class="analysis-stat-value" id="downloadSucceeded">0</div>
                <div class="analysis-stat-label">成功</div>
              </div>
              <div class="analysis-stat">
                <div class="analysis-stat-value" id="downloadFailed">0</div>
                <div class="analysis-stat-label">失败</div>
              </div>
            </div>
          </div>
          <div class="download-list" id="failedList"></div>
          <div class="action-buttons" id="retryActions" class="hidden">
            <button class="btn btn-warning" onclick="retryFailed()">
              🔄 重试失败项
            </button>
            <button class="btn btn-primary" onclick="resetWorkflow()">
              ↩️ 返回
            </button>
          </div>
        </div>
      </div>

      <!-- 任务状态 -->
      <div class="card">
        <h2>📊 任务状态</h2>
        <div id="taskList">
          <p style="color: #666; text-align: center; padding: 20px;">暂无运行中的任务</p>
        </div>
      </div>
    </div>

    <!-- 执行日志 -->
    <div class="card">
      <h2>📜 执行日志</h2>
      <div class="log-container" id="logContainer">
        <div class="log-entry info">
          <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
          系统就绪，等待操作...
        </div>
      </div>
      <div style="margin-top: 10px; display: flex; gap: 10px;">
        <button class="btn btn-warning" onclick="clearLogs()">清空日志</button>
        <button class="btn btn-primary" onclick="exportLogs()">📥 导出日志</button>
      </div>
    </div>

    <!-- 包列表 -->
    <div class="card">
      <h2>📦 已缓存的包</h2>
      <div class="package-list" id="packageList">
        <p style="color: #666; text-align: center; padding: 20px;">加载中...</p>
      </div>
    </div>

    <!-- 差分导出 -->
    <div class="card">
      <h2>📤 差分导出</h2>
      <div class="form-group">
        <label>导出历史</label>
        <div id="exportHistory" class="package-list" style="max-height: 150px;">
          <p style="color: #666; text-align: center; padding: 10px;">加载中...</p>
        </div>
      </div>
      <div class="form-group">
        <label>基准时间</label>
        <div class="option-row">
          <label><input type="radio" name="exportBase" value="last" checked><span>上次导出时间</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">从上次导出时间点开始，只导出新增或修改的文件</span></button>
        </div>
        <div class="option-row">
          <label><input type="radio" name="exportBase" value="custom"><span>自定义时间</span></label>
          <input type="datetime-local" id="customExportTime" style="margin-left: 10px; padding: 5px;" disabled>
        </div>
        <div class="option-row">
          <label><input type="radio" name="exportBase" value="full"><span>全量导出</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">导出所有文件，不考虑时间点</span></button>
        </div>
      </div>
      <div class="form-group">
        <label>导出选项</label>
        <div class="option-row">
          <label><input type="checkbox" id="exportIncludeMetadata" checked><span>包含元数据文件</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">包含 package.json 元数据文件</span></button>
        </div>
      </div>
      <button class="btn btn-primary" onclick="previewExport()" id="previewExportBtn">
        🔍 预览变更
      </button>
      <button class="btn btn-success" onclick="createExport()" id="createExportBtn" disabled>
        📦 创建导出包
      </button>

      <!-- 导出预览结果 -->
      <div id="exportPreview" class="analysis-result hidden">
        <div class="analysis-header">
          <h3 style="margin: 0; color: #2c5364;">预览结果</h3>
          <div class="analysis-stats">
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="exportFileCount">0</div>
              <div class="analysis-stat-label">文件数</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="exportPackageCount">0</div>
              <div class="analysis-stat-label">包数</div>
            </div>
            <div class="analysis-stat">
              <div class="analysis-stat-value" id="exportTotalSize">0</div>
              <div class="analysis-stat-label">总大小</div>
            </div>
          </div>
        </div>
        <div class="download-list" id="exportFileList" style="max-height: 200px;"></div>
      </div>

      <!-- 导出进度 -->
      <div id="exportProgress" class="detailed-progress hidden">
        <div class="progress-header">
          <span class="progress-phase" id="exportProgressPhase">准备中...</span>
          <span class="progress-percentage" id="exportProgressPercentage">0%</span>
        </div>
        <div class="progress-bar-large">
          <div class="progress-bar-fill" id="exportProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-current-pkg" id="exportProgressMessage">等待开始...</div>
      </div>

      <!-- 导出完成 -->
      <div id="exportComplete" class="analysis-result hidden">
        <div style="text-align: center; padding: 20px;">
          <div style="font-size: 48px; margin-bottom: 10px;">✅</div>
          <h3 style="color: #28a745; margin-bottom: 15px;">导出完成</h3>
          <p id="exportFilename" style="color: #666; margin-bottom: 15px;"></p>
          <a id="exportDownloadLink" href="#" class="btn btn-success" download>
            📥 下载导出包
          </a>
          <button class="btn btn-primary" onclick="resetExport()" style="margin-left: 10px;">
            ↩️ 返回
          </button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = '/_/ingest';
    let currentTaskId = null;
    let taskPollInterval = null;
    let currentAnalysis = null;
    let failedPackages = [];
    let currentRepairScan = null;
    let repairFailedPackages = [];

    // 添加日志
    function addLog(message, type = 'info') {
      const container = document.getElementById('logContainer');
      const time = new Date().toLocaleTimeString();
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      entry.innerHTML = '<span class="log-time">[' + time + ']</span>' + message;
      container.appendChild(entry);
      container.scrollTop = container.scrollHeight;
    }

    // 清空日志
    function clearLogs() {
      const container = document.getElementById('logContainer');
      container.innerHTML = '<div class="log-entry info"><span class="log-time">[' +
        new Date().toLocaleTimeString() + ']</span>日志已清空</div>';
    }

    // 导出日志
    function exportLogs() {
      const container = document.getElementById('logContainer');
      const entries = container.querySelectorAll('.log-entry');
      let logText = '=== Verdaccio Offline Sync 日志导出 ===\\n';
      logText += '导出时间: ' + new Date().toLocaleString() + '\\n';
      logText += '==========================================\\n\\n';

      entries.forEach(entry => {
        const time = entry.querySelector('.log-time')?.textContent || '';
        const type = entry.classList.contains('error') ? '[ERROR]' :
                     entry.classList.contains('warning') ? '[WARN]' :
                     entry.classList.contains('success') ? '[SUCCESS]' : '[INFO]';
        const message = entry.textContent.replace(time, '').trim();
        logText += time + ' ' + type + ' ' + message + '\\n';
      });

      // 创建下载链接
      const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'verdaccio-sync-log-' + new Date().toISOString().slice(0, 10) + '.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      addLog('日志已导出', 'success');
    }

    // 重建本地索引（内网元数据修复）
    async function rebuildIndex() {
      try {
        addLog('正在重建本地包索引...', 'info');
        addLog('此操作将扫描存储目录并修复元数据', 'info');

        const response = await fetch(API_BASE + '/rebuild-index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (data.success) {
          addLog('索引重建完成!', 'success');
          if (data.scanned !== undefined) {
            addLog('扫描包数: ' + data.scanned + ', 修复版本: ' + data.healed + ', 更新标签: ' + data.tagsUpdated, 'success');
          }
          refreshCacheStatus();
        } else {
          addLog('索引重建失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('索引重建失败: ' + error.message, 'error');
      }
    }

    // 刷新缓存状态
    let cacheStatusPollTimer = null;
    async function refreshCacheStatus() {
      try {
        const response = await fetch(API_BASE + '/cache');
        const data = await response.json();

        document.getElementById('totalPackages').textContent = data.totalPackages || 0;
        document.getElementById('totalVersions').textContent = data.totalVersions || 0;

        const lastSyncEl = document.getElementById('lastSync');
        if (data.builtAt) {
          lastSyncEl.textContent = formatBuiltAt(data.builtAt) + (data.rebuilding ? ' (后台更新中)' : '');
        } else {
          lastSyncEl.textContent = data.rebuilding ? '扫描中…' : '-';
        }

        // 更新包列表
        updatePackageList(data.packages || []);

        if (data.rebuilding) {
          // 服务端正在后台全量扫描，稍后再拉取最新结果
          scheduleCacheStatusPoll();
          addLog('缓存统计正在后台扫描更新…');
        } else {
          addLog('缓存状态已更新: ' + data.totalPackages + ' 个包, ' + data.totalVersions + ' 个版本', 'success');
        }
      } catch (error) {
        addLog('获取缓存状态失败: ' + error.message, 'error');
      }
    }

    // 后台扫描期间定时轮询缓存状态
    function scheduleCacheStatusPoll() {
      if (cacheStatusPollTimer) {
        return;
      }
      cacheStatusPollTimer = setTimeout(function() {
        cacheStatusPollTimer = null;
        refreshCacheStatus();
      }, 8000);
    }

    // 格式化扫描快照时间
    function formatBuiltAt(ms) {
      const d = new Date(ms);
      const pad = function(n) { return n < 10 ? '0' + n : '' + n; };
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // 更新包列表
    function updatePackageList(packages) {
      const container = document.getElementById('packageList');
      if (packages.length === 0) {
        container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">暂无缓存的包</p>';
        return;
      }

      container.innerHTML = packages.slice(0, 50).map(pkg =>
        '<div class="package-item">' +
          '<div>' +
            '<div class="package-name">' + pkg.name + '</div>' +
            '<div class="package-versions">' + pkg.versions.length + ' 个版本, 最新: ' + pkg.latestCached + '</div>' +
          '</div>' +
        '</div>'
      ).join('');

      if (packages.length > 50) {
        container.innerHTML += '<p style="text-align: center; color: #666; padding: 10px;">... 还有 ' +
          (packages.length - 50) + ' 个包</p>';
      }
    }

    // 刷新所有元数据
    async function refreshAllMetadata() {
      try {
        addLog('正在刷新所有包的元数据...');
        const response = await fetch(API_BASE + '/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true })
        });
        const data = await response.json();

        if (data.success) {
          addLog('元数据刷新完成: 已刷新 ' + data.refreshed + ' 个包', 'success');
          refreshCacheStatus();
        } else {
          addLog('元数据刷新失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('元数据刷新失败: ' + error.message, 'error');
      }
    }

    // ==================== 元数据同步相关函数 ====================
    const SYNC_API_BASE = '/_/healer';
    let syncTaskId = null;
    let syncPollInterval = null;

    // 同步所有包元数据
    async function startSyncAll() {
      try {
        document.getElementById('syncAllBtn').disabled = true;
        document.getElementById('syncResult').classList.add('hidden');
        document.getElementById('syncProgress').classList.remove('hidden');
        addLog('正在启动全量元数据同步...', 'info');

        const response = await fetch(SYNC_API_BASE + '/sync-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          syncTaskId = data.taskId;
          addLog('同步任务已启动: ' + data.taskId + ' (共 ' + data.totalPackages + ' 个包)', 'success');
          startSyncPolling(data.taskId);
        } else {
          addLog('启动同步失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('syncAllBtn').disabled = false;
          document.getElementById('syncProgress').classList.add('hidden');
        }
      } catch (error) {
        addLog('启动同步失败: ' + error.message, 'error');
        document.getElementById('syncAllBtn').disabled = false;
        document.getElementById('syncProgress').classList.add('hidden');
      }
    }

    // 同步单个包
    async function syncSinglePackage() {
      const packageName = document.getElementById('syncPackageName').value.trim();
      if (!packageName) {
        addLog('请输入包名', 'warning');
        return;
      }

      try {
        addLog('正在同步包: ' + packageName + '...', 'info');
        const response = await fetch(SYNC_API_BASE + '/sync/' + encodeURIComponent(packageName), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (data.success) {
          addLog('包 ' + packageName + ' 同步成功', 'success');
          if (data.versions) {
            addLog('版本数: ' + data.versions, 'info');
          }
        } else {
          addLog('同步失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('同步失败: ' + error.message, 'error');
      }
    }

    // 开始轮询同步状态
    function startSyncPolling(taskId) {
      if (syncPollInterval) {
        clearInterval(syncPollInterval);
      }

      syncPollInterval = setInterval(async () => {
        try {
          const response = await fetch(SYNC_API_BASE + '/sync/status/' + taskId);
          const task = await response.json();

          updateSyncProgress(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(syncPollInterval);
            syncPollInterval = null;
            document.getElementById('syncAllBtn').disabled = false;

            if (task.status === 'completed') {
              showSyncResult(task);
              addLog('元数据同步完成!', 'success');
            } else {
              showSyncError(task.error || '未知错误');
              addLog('元数据同步失败: ' + (task.error || '未知错误'), 'error');
            }
          }
        } catch (error) {
          addLog('获取同步状态失败: ' + error.message, 'error');
        }
      }, 1500);
    }

    // 更新同步进度
    function updateSyncProgress(task) {
      const progress = task.progress || 0;
      document.getElementById('syncPhase').textContent = task.status === 'running' ? '同步中...' : '准备中...';
      document.getElementById('syncPercentage').textContent = progress + '%';
      document.getElementById('syncProgressBar').style.width = progress + '%';
      document.getElementById('syncProcessed').textContent = task.processed || 0;
      document.getElementById('syncTotal').textContent = task.total || 0;
      document.getElementById('syncFailed').textContent = task.failed || 0;
      document.getElementById('syncCurrentPkg').textContent = task.currentPackage || '处理中...';
    }

    // 显示同步结果
    function showSyncResult(task) {
      document.getElementById('syncProgress').classList.add('hidden');
      document.getElementById('syncResult').classList.remove('hidden');
      document.getElementById('syncResultTotal').textContent = task.total || 0;
      document.getElementById('syncResultSuccess').textContent = (task.total || 0) - (task.failed || 0);
      document.getElementById('syncResultFailed').textContent = task.failed || 0;
    }

    // 显示同步错误
    function showSyncError(errorMsg) {
      document.getElementById('syncProgress').classList.add('hidden');
      document.getElementById('syncResult').classList.remove('hidden');
      document.getElementById('syncResultTotal').textContent = '错误';
      document.getElementById('syncResultSuccess').textContent = '-';
      document.getElementById('syncResultFailed').textContent = errorMsg;
    }

    // 加载包列表（从 healer）
    async function loadPackageList() {
      try {
        document.getElementById('loadPkgListBtn').disabled = true;
        document.getElementById('syncPackageList').classList.remove('hidden');
        document.getElementById('syncPkgListContainer').innerHTML =
          '<p style="color: #666; text-align: center; padding: 20px;">加载中...</p>';

        const response = await fetch(SYNC_API_BASE + '/packages');
        const data = await response.json();

        if (data.success && data.packages) {
          const container = document.getElementById('syncPkgListContainer');
          if (data.packages.length === 0) {
            container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">暂无包</p>';
          } else {
            container.innerHTML = data.packages.slice(0, 100).map(pkg =>
              '<div class="package-item">' +
                '<div>' +
                  '<div class="package-name">' + pkg + '</div>' +
                '</div>' +
                '<button class="btn btn-primary" style="padding: 3px 10px; font-size: 12px;" onclick="syncPackageFromList(\\'' + pkg.replace(/'/g, "\\\\'") + '\\')">同步</button>' +
              '</div>'
            ).join('');

            if (data.packages.length > 100) {
              container.innerHTML += '<p style="text-align: center; color: #666; padding: 10px;">... 还有 ' +
                (data.packages.length - 100) + ' 个包</p>';
            }
          }
          addLog('已加载 ' + data.packages.length + ' 个包', 'success');
        } else {
          addLog('加载包列表失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('加载包列表失败: ' + error.message, 'error');
      } finally {
        document.getElementById('loadPkgListBtn').disabled = false;
      }
    }

    // 隐藏包列表
    function hidePackageList() {
      document.getElementById('syncPackageList').classList.add('hidden');
    }

    // 从列表同步单个包
    async function syncPackageFromList(packageName) {
      document.getElementById('syncPackageName').value = packageName;
      await syncSinglePackage();
    }

    // 显示同步对话框
    function showSyncDialog() {
      document.getElementById('syncDialog').scrollIntoView({ behavior: 'smooth' });
    }

    // 获取选中的平台
    function getSelectedPlatforms() {
      const checkboxes = document.querySelectorAll('input[name="platform"]:checked');
      const platformMap = {
        'linux-x64': { os: 'linux', arch: 'x64', libc: 'glibc' },
        'linux-arm64': { os: 'linux', arch: 'arm64', libc: 'glibc' },
        'win32-x64': { os: 'win32', arch: 'x64' },
        'win32-arm64': { os: 'win32', arch: 'arm64' },
        'darwin-x64': { os: 'darwin', arch: 'x64' },
        'darwin-arm64': { os: 'darwin', arch: 'arm64' }
      };
      return Array.from(checkboxes).map(cb => platformMap[cb.value]);
    }

    // 格式化时间（毫秒转为可读格式）
    function formatTime(ms) {
      if (!ms || ms <= 0) return '--';
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + '秒';
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      if (minutes < 60) return minutes + '分' + remainingSeconds + '秒';
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return hours + '时' + remainingMinutes + '分';
    }

    // 阶段名称映射
    const phaseLabels = {
      'scanning': '扫描本地缓存',
      'refreshing': '准备元数据',
      'analyzing': '分析依赖关系',
      'detecting-binaries': '检测平台二进制包',
      'completed': '分析完成'
    };

    // 更新分析进度显示
    function updateAnalysisProgress(task) {
      const progressDiv = document.getElementById('analysisProgress');
      progressDiv.classList.remove('hidden');

      const progress = task.detailedProgress || {};
      const totalProgress = task.progress || progress.totalProgress || 0;

      document.getElementById('progressPhase').textContent = phaseLabels[progress.phase] || progress.phaseDescription || '处理中...';
      document.getElementById('progressPercentage').textContent = totalProgress + '%';
      document.getElementById('analysisProgressBar').style.width = totalProgress + '%';
      document.getElementById('progressProcessed').textContent = progress.processed || 0;
      document.getElementById('progressTotal').textContent = progress.total || 0;
      document.getElementById('progressETA').textContent = formatTime(progress.estimatedRemaining);
      document.getElementById('progressCurrentPkg').textContent = progress.currentPackage || progress.phaseDescription || '处理中...';
    }

    // 开始分析
    async function startAnalysis() {
      const platforms = getSelectedPlatforms();
      if (platforms.length === 0) {
        addLog('请至少选择一个目标平台', 'warning');
        return;
      }

      const options = {
        refreshAllMetadataBeforeAnalyze: document.getElementById('refreshAllMetadataBeforeAnalyze').checked,
        updateToLatest: document.getElementById('updateToLatest').checked,
        includeOptional: document.getElementById('includeOptional').checked,
        includePeer: document.getElementById('includePeer').checked,
        completeSiblingVersions: document.getElementById('completeSiblingVersions').checked
      };

      if (!options.refreshAllMetadataBeforeAnalyze &&
          (options.updateToLatest || options.completeSiblingVersions)) {
        addLog('未开启“分析前全量刷新元数据”，升级/同级补全将仅基于本地元数据判断', 'warning');
      }

      try {
        document.getElementById('analyzeBtn').disabled = true;
        document.getElementById('analysisResult').classList.add('hidden');
        addLog('正在启动分析任务...', 'info');
        addLog('目标平台: ' + platforms.map(p => p.os + '-' + p.arch).join(', '));

        const response = await fetch(API_BASE + '/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platforms, options })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('分析任务已启动: ' + data.taskId, 'success');
          startAnalysisPolling(data.taskId);
        } else {
          addLog('启动分析任务失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('analyzeBtn').disabled = false;
        }
      } catch (error) {
        addLog('启动分析任务失败: ' + error.message, 'error');
        document.getElementById('analyzeBtn').disabled = false;
      }
    }

    // 开始轮询分析状态
    function startAnalysisPolling(taskId) {
      if (taskPollInterval) {
        clearInterval(taskPollInterval);
      }

      taskPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          // 更新详细进度
          updateAnalysisProgress(task);
          updateTaskDisplay(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(taskPollInterval);
            taskPollInterval = null;
            document.getElementById('analysisProgress').classList.add('hidden');

            if (task.status === 'completed' && task.result) {
              currentAnalysis = task.result;
              addLog('分析完成: 扫描 ' + task.result.scanned + ' 个包, 待下载 ' + task.result.toDownload.length + ' 个', 'success');
              showAnalysisResult(task.result);
            } else {
              addLog('分析任务失败: ' + (task.error || '未知错误'), 'error');
            }
            document.getElementById('analyzeBtn').disabled = false;
          }
        } catch (error) {
          addLog('获取任务状态失败: ' + error.message, 'error');
        }
      }, 1000); // 每秒轮询一次
    }

    // 显示分析结果
    function showAnalysisResult(analysis) {
      document.getElementById('analysisScanned').textContent = analysis.scanned;
      document.getElementById('analysisToDownload').textContent = analysis.toDownload.length;

      const listContainer = document.getElementById('downloadList');
      if (analysis.toDownload.length === 0) {
        listContainer.innerHTML = '<p style="text-align: center; padding: 20px; color: #666;">所有依赖已是最新，无需下载</p>';
        document.getElementById('downloadBtn').disabled = true;
      } else {
        const reasonLabels = {
          'newer-version': '新版本',
          'missing-dependency': '缺失依赖',
          'platform-binary': '平台包',
          'sibling-version': '同级版本'
        };

        // 只显示前50个
        const displayList = analysis.toDownload.slice(0, 50);
        listContainer.innerHTML = displayList.map(pkg =>
          '<div class="download-item">' +
            '<div>' +
              '<span class="pkg-name">' + pkg.name + '</span>' +
              '<span class="pkg-version">@' + pkg.version + '</span>' +
            '</div>' +
            '<span class="pkg-reason">' + (reasonLabels[pkg.reason] || pkg.reason) + '</span>' +
          '</div>'
        ).join('');

        if (analysis.toDownload.length > 50) {
          listContainer.innerHTML += '<p style="text-align: center; padding: 10px; color: #666;">... 还有 ' +
            (analysis.toDownload.length - 50) + ' 个包</p>';
        }
        document.getElementById('downloadBtn').disabled = false;
      }

      document.getElementById('analysisResult').classList.remove('hidden');
      document.getElementById('downloadResult').classList.add('hidden');
    }

    // 取消分析
    function cancelAnalysis() {
      currentAnalysis = null;
      if (taskPollInterval) {
        clearInterval(taskPollInterval);
        taskPollInterval = null;
      }
      document.getElementById('analysisResult').classList.add('hidden');
      document.getElementById('analysisProgress').classList.add('hidden');
      document.getElementById('analyzeBtn').disabled = false;
      addLog('已取消分析', 'info');
    }

    // 确认下载
    async function confirmDownload() {
      if (!currentAnalysis || !currentAnalysis.analysisId) {
        addLog('没有有效的分析结果', 'error');
        return;
      }

      try {
        document.getElementById('downloadBtn').disabled = true;
        addLog('正在启动下载任务...', 'info');

        const response = await fetch(API_BASE + '/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analysisId: currentAnalysis.analysisId })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('下载任务已启动: ' + data.taskId + ' (共 ' + data.total + ' 个包)', 'success');
          startDownloadPolling(data.taskId);
        } else {
          addLog('启动下载任务失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('downloadBtn').disabled = false;
        }
      } catch (error) {
        addLog('启动下载任务失败: ' + error.message, 'error');
        document.getElementById('downloadBtn').disabled = false;
      }
    }

    // 开始轮询下载状态
    function startDownloadPolling(taskId) {
      if (taskPollInterval) {
        clearInterval(taskPollInterval);
      }

      const statusDiv = document.getElementById('quickTaskStatus');
      statusDiv.classList.remove('hidden');

      taskPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateTaskDisplay(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(taskPollInterval);
            taskPollInterval = null;

            if (task.status === 'completed' && task.result) {
              addLog('下载完成! 成功: ' + task.result.succeeded + ', 失败: ' + task.result.failed,
                task.result.failed > 0 ? 'warning' : 'success');
              showDownloadResult(task.result);
            } else {
              addLog('下载任务失败: ' + (task.error || '未知错误'), 'error');
            }
            refreshCacheStatus();
          }
        } catch (error) {
          addLog('获取任务状态失败: ' + error.message, 'error');
        }
      }, 2000);
    }

    // 显示下载结果
    function showDownloadResult(result) {
      document.getElementById('downloadSucceeded').textContent = result.succeeded;
      document.getElementById('downloadFailed').textContent = result.failed;

      const failedListContainer = document.getElementById('failedList');
      failedPackages = result.failedPackages || [];

      if (failedPackages.length === 0) {
        failedListContainer.innerHTML = '<p style="text-align: center; padding: 20px; color: #28a745;">全部下载成功!</p>';
        document.getElementById('retryActions').innerHTML =
          '<button class="btn btn-primary" onclick="resetWorkflow()">↩️ 返回</button>';
      } else {
        failedListContainer.innerHTML = failedPackages.map(pkg =>
          '<div class="download-item failed">' +
            '<div>' +
              '<span class="pkg-name">' + pkg.name + '</span>' +
              '<span class="pkg-version">@' + pkg.version + '</span>' +
            '</div>' +
            '<span class="pkg-status failed">失败</span>' +
          '</div>'
        ).join('');
      }

      document.getElementById('analysisResult').classList.add('hidden');
      document.getElementById('downloadResult').classList.remove('hidden');
    }

    // 重试失败项
    async function retryFailed() {
      if (failedPackages.length === 0) {
        addLog('没有需要重试的包', 'info');
        return;
      }

      try {
        addLog('正在重试 ' + failedPackages.length + ' 个失败的包...', 'info');

        const response = await fetch(API_BASE + '/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packages: failedPackages })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('重试任务已启动: ' + data.taskId, 'success');
          startDownloadPolling(data.taskId);
        } else {
          addLog('启动重试任务失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('启动重试任务失败: ' + error.message, 'error');
      }
    }

    // 重置工作流
    function resetWorkflow() {
      currentAnalysis = null;
      failedPackages = [];
      document.getElementById('analysisResult').classList.add('hidden');
      document.getElementById('downloadResult').classList.add('hidden');
      document.getElementById('quickTaskStatus').classList.add('hidden');
      document.getElementById('analysisProgress').classList.add('hidden');
      document.getElementById('analyzeBtn').disabled = false;
      document.getElementById('downloadBtn').disabled = false;
    }

    // ==================== 完整性检查与修复 ====================

    const repairReasonLabels = {
      'dist-tag-latest': 'latest',
      'major-latest': '大版本最新',
      'dependent-range': '依赖命中'
    };

    // 开始完整性扫描
    async function startRepairScan() {
      try {
        const versionScope = document.querySelector('input[name="repairVersionScope"]:checked')?.value || 'latest';
        document.getElementById('repairScanBtn').disabled = true;
        document.getElementById('repairPreview').classList.add('hidden');
        document.getElementById('repairResult').classList.add('hidden');
        document.getElementById('repairProgress').classList.add('hidden');
        addLog('正在启动完整性扫描（' + (versionScope === 'latest' ? '仅最新版本' : '智能模式') + '）...', 'info');

        const response = await fetch(API_BASE + '/repair/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ options: { versionScope } })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('完整性扫描任务已启动: ' + data.taskId, 'success');
          document.getElementById('repairScanProgress').classList.remove('hidden');
          startRepairScanPolling(data.taskId);
        } else {
          addLog('启动完整性扫描失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('repairScanBtn').disabled = false;
        }
      } catch (error) {
        addLog('启动完整性扫描失败: ' + error.message, 'error');
        document.getElementById('repairScanBtn').disabled = false;
      }
    }

    // 轮询扫描状态
    function startRepairScanPolling(taskId) {
      if (taskPollInterval) {
        clearInterval(taskPollInterval);
      }

      taskPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateRepairScanProgress(task);
          updateTaskDisplay(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(taskPollInterval);
            taskPollInterval = null;
            document.getElementById('repairScanProgress').classList.add('hidden');
            document.getElementById('repairScanBtn').disabled = false;

            if (task.status === 'completed' && task.result) {
              currentRepairScan = task.result;
              addLog('扫描完成: 发现 ' + task.result.incompleteCount + ' 个残缺包, 待下载 ' +
                task.result.totalVersionsToDownload + ' 个版本', 'success');
              showRepairPreview(task.result);
            } else {
              addLog('完整性扫描失败: ' + (task.error || '未知错误'), 'error');
            }
          }
        } catch (error) {
          addLog('获取扫描状态失败: ' + error.message, 'error');
        }
      }, 1000);
    }

    // 更新扫描进度显示
    function updateRepairScanProgress(task) {
      const progress = task.detailedProgress;
      if (!progress) {
        return;
      }

      const phaseNames = {
        'scanning': '扫描存储',
        'analyzing': '分析依赖',
        'completed': '完成'
      };

      document.getElementById('repairScanPhase').textContent =
        phaseNames[progress.phase] || progress.phase;
      document.getElementById('repairScanPercentage').textContent =
        (progress.totalProgress || 0) + '%';
      document.getElementById('repairScanProgressBar').style.width =
        (progress.totalProgress || 0) + '%';
      document.getElementById('repairScanProcessed').textContent = progress.processed || 0;
      document.getElementById('repairScanTotal').textContent = progress.total || 0;

      if (progress.estimatedRemaining) {
        const seconds = Math.round(progress.estimatedRemaining / 1000);
        document.getElementById('repairScanETA').textContent =
          seconds > 60 ? Math.floor(seconds / 60) + 'm' + (seconds % 60) + 's' : seconds + 's';
      }

      document.getElementById('repairScanCurrentPkg').textContent =
        progress.currentPackage || progress.phaseDescription || '处理中...';
    }

    // 显示扫描预览
    function showRepairPreview(result) {
      document.getElementById('repairScopeLabel').textContent =
        '（' + (result.options && result.options.versionScope === 'smart' ? '智能模式' : '仅最新版本') + '）';
      document.getElementById('repairIncompleteCount').textContent = result.incompleteCount;
      document.getElementById('repairVersionsToDownload').textContent =
        result.totalVersionsToDownload;
      document.getElementById('repairUnrepairableCount').textContent =
        (result.unrepairable || []).length;

      const listContainer = document.getElementById('repairPlanList');
      const plans = result.plans || [];

      if (plans.length === 0) {
        listContainer.innerHTML =
          '<p style="text-align: center; padding: 20px; color: #28a745;">没有需要修复的包</p>';
        document.getElementById('repairConfirmBtn').disabled = true;
      } else {
        const displayList = plans.slice(0, 50);
        listContainer.innerHTML = displayList.map(plan => {
          const versionsText = plan.selectedVersions.map(sv => sv.version).join(', ');
          const reasonsText = [...new Set(
            plan.selectedVersions.flatMap(sv =>
              sv.reasons.map(r => repairReasonLabels[r] || r))
          )].join(' / ');
          const detail = plan.selectedVersions.map(sv =>
            sv.version + ' [' + sv.reasons.map(r => repairReasonLabels[r] || r).join(',') + ']'
          ).join('\\n');
          return '<div class="download-item" title="' + detail + '">' +
            '<div>' +
              '<span class="pkg-name">' + plan.name + '</span>' +
              '<span class="pkg-version">' + versionsText + '</span>' +
            '</div>' +
            '<span class="pkg-reason">' + plan.selectedVersions.length + ' 版本: ' +
              reasonsText + '</span>' +
          '</div>';
        }).join('');

        if (plans.length > 50) {
          listContainer.innerHTML += '<p style="text-align: center; padding: 10px; color: #666;">... 还有 ' +
            (plans.length - 50) + ' 个包</p>';
        }
        document.getElementById('repairConfirmBtn').disabled = false;
      }

      // 无法修复的包（如有）
      const unrepairable = result.unrepairable || [];
      const unrepairableContainer = document.getElementById('repairUnrepairableList');
      if (unrepairable.length > 0) {
        const displayUnrepairable = unrepairable.slice(0, 20);
        unrepairableContainer.innerHTML =
          '<p style="color: #856404; font-size: 13px; margin-bottom: 5px;">⚠️ 以下 ' +
          unrepairable.length + ' 个包无法自动修复:</p>' +
          displayUnrepairable.map(item =>
            '<div style="font-size: 12px; color: #666; padding: 2px 0;">' +
              item.name + ' — ' + item.reason +
            '</div>'
          ).join('') +
          (unrepairable.length > 20
            ? '<div style="font-size: 12px; color: #666;">... 还有 ' +
              (unrepairable.length - 20) + ' 个</div>'
            : '');
      } else {
        unrepairableContainer.innerHTML = '';
      }

      document.getElementById('repairPreview').classList.remove('hidden');
      document.getElementById('repairResult').classList.add('hidden');
    }

    // 取消修复
    function cancelRepair() {
      currentRepairScan = null;
      document.getElementById('repairPreview').classList.add('hidden');
      document.getElementById('repairScanProgress').classList.add('hidden');
      document.getElementById('repairScanBtn').disabled = false;
      addLog('已取消修复', 'info');
    }

    // 确认修复
    async function confirmRepair() {
      if (!currentRepairScan || !currentRepairScan.scanId) {
        addLog('没有有效的扫描结果', 'error');
        return;
      }

      try {
        document.getElementById('repairConfirmBtn').disabled = true;
        addLog('正在启动修复任务...', 'info');

        const response = await fetch(API_BASE + '/repair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanId: currentRepairScan.scanId })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('修复任务已启动: ' + data.taskId + ' (共 ' + data.total + ' 个版本)', 'success');
          document.getElementById('repairPreview').classList.add('hidden');
          document.getElementById('repairProgress').classList.remove('hidden');
          startRepairPolling(data.taskId);
        } else {
          addLog('启动修复任务失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('repairConfirmBtn').disabled = false;
        }
      } catch (error) {
        addLog('启动修复任务失败: ' + error.message, 'error');
        document.getElementById('repairConfirmBtn').disabled = false;
      }
    }

    // 轮询修复状态
    function startRepairPolling(taskId) {
      if (taskPollInterval) {
        clearInterval(taskPollInterval);
      }

      taskPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          document.getElementById('repairPercentage').textContent = (task.progress || 0) + '%';
          document.getElementById('repairProgressBar').style.width = (task.progress || 0) + '%';
          document.getElementById('repairCurrentPkg').textContent = task.message || '下载中...';
          updateTaskDisplay(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(taskPollInterval);
            taskPollInterval = null;
            document.getElementById('repairProgress').classList.add('hidden');
            document.getElementById('repairScanBtn').disabled = false;

            if (task.status === 'completed' && task.result) {
              addLog('修复完成! 成功: ' + task.result.succeeded + ', 失败: ' + task.result.failed,
                task.result.failed > 0 ? 'warning' : 'success');
              showRepairResult(task.result);
            } else {
              addLog('修复任务失败: ' + (task.error || '未知错误'), 'error');
            }
            refreshCacheStatus();
          }
        } catch (error) {
          addLog('获取修复状态失败: ' + error.message, 'error');
        }
      }, 2000);
    }

    // 显示修复结果
    function showRepairResult(result) {
      document.getElementById('repairRepairedPackages').textContent =
        result.repairedPackages || 0;
      document.getElementById('repairSucceeded').textContent = result.succeeded;
      document.getElementById('repairFailed').textContent = result.failed;
      document.getElementById('repairUpstreamMissing').textContent =
        (result.upstreamMissing || []).length;

      // 上游已下架的版本重试无效，从可重试列表中剔除
      const upstreamMissingKeys = new Set(
        (result.upstreamMissing || []).map(pkg => pkg.name + '@' + pkg.version)
      );
      repairFailedPackages = (result.failedPackages || []).filter(
        pkg => !upstreamMissingKeys.has(pkg.name + '@' + pkg.version)
      );

      const failedListContainer = document.getElementById('repairFailedList');
      const allFailed = result.failedPackages || [];

      if (allFailed.length === 0) {
        failedListContainer.innerHTML =
          '<p style="text-align: center; padding: 20px; color: #28a745;">全部修复成功!</p>';
      } else {
        failedListContainer.innerHTML = allFailed.map(pkg => {
          const isMissing = upstreamMissingKeys.has(pkg.name + '@' + pkg.version);
          return '<div class="download-item failed">' +
            '<div>' +
              '<span class="pkg-name">' + pkg.name + '</span>' +
              '<span class="pkg-version">@' + pkg.version + '</span>' +
            '</div>' +
            '<span class="pkg-status failed">' +
              (isMissing ? '上游已下架' : '失败') +
            '</span>' +
          '</div>';
        }).join('');
      }

      document.getElementById('repairRetryBtn').disabled = repairFailedPackages.length === 0;
      document.getElementById('repairResult').classList.remove('hidden');
    }

    // 重试修复失败项（上游已下架的已剔除）
    async function retryRepairFailed() {
      if (repairFailedPackages.length === 0) {
        addLog('没有可重试的包（上游已下架的版本无法重试）', 'info');
        return;
      }

      try {
        addLog('正在重试 ' + repairFailedPackages.length + ' 个失败的版本...', 'info');

        const response = await fetch(API_BASE + '/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packages: repairFailedPackages })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('重试任务已启动: ' + data.taskId, 'success');
          document.getElementById('repairResult').classList.add('hidden');
          document.getElementById('repairProgress').classList.remove('hidden');
          startRepairPolling(data.taskId);
        } else {
          addLog('启动重试任务失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('启动重试任务失败: ' + error.message, 'error');
      }
    }

    // 重置修复工作流
    function resetRepairWorkflow() {
      currentRepairScan = null;
      repairFailedPackages = [];
      document.getElementById('repairPreview').classList.add('hidden');
      document.getElementById('repairResult').classList.add('hidden');
      document.getElementById('repairProgress').classList.add('hidden');
      document.getElementById('repairScanProgress').classList.add('hidden');
      document.getElementById('repairScanBtn').disabled = false;
      document.getElementById('repairConfirmBtn').disabled = false;
    }

    // 开始同步（保留旧的一键同步功能）
    async function startSync() {
      const platforms = getSelectedPlatforms();
      if (platforms.length === 0) {
        addLog('请至少选择一个目标平台', 'warning');
        return;
      }

      const options = {
        refreshAllMetadataBeforeAnalyze: document.getElementById('refreshAllMetadataBeforeAnalyze').checked,
        updateToLatest: document.getElementById('updateToLatest').checked,
        includeOptional: document.getElementById('includeOptional').checked,
        includePeer: document.getElementById('includePeer').checked,
        completeSiblingVersions: document.getElementById('completeSiblingVersions').checked
      };

      if (!options.refreshAllMetadataBeforeAnalyze &&
          (options.updateToLatest || options.completeSiblingVersions)) {
        addLog('未开启“分析前全量刷新元数据”，升级/同级补全将仅基于本地元数据判断', 'warning');
      }

      try {
        addLog('正在启动同步任务...', 'info');
        addLog('目标平台: ' + platforms.map(p => p.os + '-' + p.arch).join(', '));

        const response = await fetch(API_BASE + '/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platforms, options })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('同步任务已启动: ' + data.taskId, 'success');
          startTaskPolling(data.taskId);
        } else {
          addLog('启动同步任务失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('启动同步任务失败: ' + error.message, 'error');
      }
    }

    // 开始轮询任务状态
    function startTaskPolling(taskId) {
      if (taskPollInterval) {
        clearInterval(taskPollInterval);
      }

      const statusDiv = document.getElementById('quickTaskStatus');
      statusDiv.classList.remove('hidden');

      taskPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateTaskDisplay(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(taskPollInterval);
            taskPollInterval = null;

            if (task.status === 'completed') {
              addLog('同步任务完成!', 'success');
              if (task.result) {
                addLog('扫描: ' + task.result.scanned + ' 个包, 刷新: ' + task.result.refreshed +
                  ' 个, 下载: ' + task.result.downloaded + ' 个', 'success');
              }
              refreshCacheStatus();
            } else {
              addLog('同步任务失败: ' + (task.error || '未知错误'), 'error');
            }
          }
        } catch (error) {
          addLog('获取任务状态失败: ' + error.message, 'error');
        }
      }, 2000);
    }

    // 更新任务显示
    function updateTaskDisplay(task) {
      const progressBar = document.getElementById('quickProgress');
      const messageEl = document.getElementById('quickMessage');

      progressBar.style.width = (task.progress || 0) + '%';
      messageEl.textContent = task.message || '处理中...';

      // 更新任务列表
      const taskList = document.getElementById('taskList');
      taskList.innerHTML =
        '<div class="package-item">' +
          '<div>' +
            '<div class="package-name">任务 ' + task.taskId + '</div>' +
            '<div class="package-versions">' + (task.message || '处理中...') + '</div>' +
          '</div>' +
          '<span class="status-badge ' + task.status + '">' + task.status + '</span>' +
        '</div>';
    }

    // ==================== 差分导出相关函数 ====================

    let currentExportTaskId = null;
    let exportPollInterval = null;
    let currentExportPreview = null;

    // 加载导出历史
    async function loadExportHistory() {
      try {
        const response = await fetch(API_BASE + '/export/history');
        const data = await response.json();

        const historyContainer = document.getElementById('exportHistory');
        if (!data.history || data.history.length === 0) {
          historyContainer.innerHTML = '<p style="color: #666; text-align: center; padding: 10px;">暂无导出记录</p>';
          return;
        }

        // 显示最近5条记录
        const recentExports = data.history.slice(-5).reverse();
        historyContainer.innerHTML = recentExports.map(exp =>
          '<div class="package-item">' +
            '<div>' +
              '<div class="package-name">' + exp.filename + '</div>' +
              '<div class="package-versions">' +
                exp.summary.packages + ' 个包, ' + exp.summary.versions + ' 个版本, ' +
                formatSize(exp.totalSize) +
              '</div>' +
            '</div>' +
            '<span class="status-badge completed">' + exp.type + '</span>' +
          '</div>'
        ).join('');
      } catch (error) {
        addLog('加载导出历史失败: ' + error.message, 'error');
      }
    }

    // 格式化文件大小
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    // 获取导出基准时间
    function getExportBaseTime() {
      const selected = document.querySelector('input[name="exportBase"]:checked').value;
      if (selected === 'last') {
        return 'last';
      } else if (selected === 'custom') {
        const customTime = document.getElementById('customExportTime').value;
        if (!customTime) {
          addLog('请选择自定义时间', 'warning');
          return null;
        }
        return new Date(customTime).toISOString();
      } else {
        return undefined; // 全量导出
      }
    }

    // 预览导出
    async function previewExport() {
      const since = getExportBaseTime();
      if (since === null) return;

      const includeMetadata = document.getElementById('exportIncludeMetadata').checked;

      try {
        document.getElementById('previewExportBtn').disabled = true;
        addLog('正在预览待导出文件...', 'info');

        const response = await fetch(API_BASE + '/export/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ since, includeMetadata })
        });
        const data = await response.json();

        if (data.success) {
          currentExportPreview = data;
          showExportPreview(data);
          addLog('预览完成: ' + data.stats.totalFiles + ' 个文件, ' + formatSize(data.stats.totalSize), 'success');
        } else {
          addLog('预览失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('预览失败: ' + error.message, 'error');
      } finally {
        document.getElementById('previewExportBtn').disabled = false;
      }
    }

    // 显示导出预览结果
    function showExportPreview(data) {
      document.getElementById('exportFileCount').textContent = data.stats.totalFiles;
      document.getElementById('exportPackageCount').textContent = data.stats.packages;
      document.getElementById('exportTotalSize').textContent = formatSize(data.stats.totalSize);

      const fileList = document.getElementById('exportFileList');
      if (data.files.length === 0) {
        fileList.innerHTML = '<p style="text-align: center; padding: 20px; color: #666;">没有需要导出的文件</p>';
        document.getElementById('createExportBtn').disabled = true;
      } else {
        // 只显示前30个文件
        const displayFiles = data.files.slice(0, 30);
        fileList.innerHTML = displayFiles.map(file =>
          '<div class="download-item">' +
            '<div>' +
              '<span class="pkg-name">' + (file.packageName || file.path) + '</span>' +
              (file.version ? '<span class="pkg-version">@' + file.version + '</span>' : '') +
            '</div>' +
            '<span class="pkg-reason">' + (file.type === 'tarball' ? 'tarball' : 'metadata') + '</span>' +
          '</div>'
        ).join('');

        if (data.files.length > 30) {
          fileList.innerHTML += '<p style="text-align: center; padding: 10px; color: #666;">... 还有 ' +
            (data.files.length - 30) + ' 个文件</p>';
        }
        document.getElementById('createExportBtn').disabled = false;
      }

      document.getElementById('exportPreview').classList.remove('hidden');
      document.getElementById('exportProgress').classList.add('hidden');
      document.getElementById('exportComplete').classList.add('hidden');
    }

    // 创建导出包
    async function createExport() {
      const since = getExportBaseTime();
      if (since === null) return;

      const includeMetadata = document.getElementById('exportIncludeMetadata').checked;

      try {
        document.getElementById('createExportBtn').disabled = true;
        document.getElementById('previewExportBtn').disabled = true;
        addLog('正在创建导出包...', 'info');

        const response = await fetch(API_BASE + '/export/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ since, includeMetadata })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentExportTaskId = data.taskId;
          addLog('导出任务已启动: ' + data.taskId, 'success');
          startExportPolling(data.taskId);
        } else {
          addLog('创建导出失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('createExportBtn').disabled = false;
          document.getElementById('previewExportBtn').disabled = false;
        }
      } catch (error) {
        addLog('创建导出失败: ' + error.message, 'error');
        document.getElementById('createExportBtn').disabled = false;
        document.getElementById('previewExportBtn').disabled = false;
      }
    }

    // 开始轮询导出状态
    function startExportPolling(taskId) {
      if (exportPollInterval) {
        clearInterval(exportPollInterval);
      }

      document.getElementById('exportPreview').classList.add('hidden');
      document.getElementById('exportProgress').classList.remove('hidden');

      exportPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateExportProgress(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(exportPollInterval);
            exportPollInterval = null;

            if (task.status === 'completed' && task.result) {
              addLog('导出完成: ' + task.result.filename, 'success');
              showExportComplete(task.result);
              loadExportHistory(); // 刷新历史
            } else {
              addLog('导出失败: ' + (task.error || '未知错误'), 'error');
              resetExport();
            }
          }
        } catch (error) {
          addLog('获取导出状态失败: ' + error.message, 'error');
        }
      }, 1000);
    }

    // 更新导出进度显示
    function updateExportProgress(task) {
      const progress = task.detailedProgress || {};
      const totalProgress = task.progress || progress.totalProgress || 0;

      const exportPhaseLabels = {
        'scanning': '扫描文件',
        'calculating-checksums': '计算校验和',
        'packing': '打包文件',
        'finalizing': '生成压缩包',
        'completed': '导出完成'
      };

      document.getElementById('exportProgressPhase').textContent =
        exportPhaseLabels[progress.phase] || progress.phaseDescription || '处理中...';
      document.getElementById('exportProgressPercentage').textContent = totalProgress + '%';
      document.getElementById('exportProgressBar').style.width = totalProgress + '%';
      document.getElementById('exportProgressMessage').textContent =
        progress.currentFile || progress.phaseDescription || '处理中...';
    }

    // 显示导出完成
    function showExportComplete(result) {
      document.getElementById('exportProgress').classList.add('hidden');
      document.getElementById('exportComplete').classList.remove('hidden');

      document.getElementById('exportFilename').textContent =
        result.filename + ' (' + formatSize(result.fileSize) + ')';
      document.getElementById('exportDownloadLink').href = result.downloadUrl;
    }

    // 重置导出状态
    function resetExport() {
      currentExportPreview = null;
      currentExportTaskId = null;
      if (exportPollInterval) {
        clearInterval(exportPollInterval);
        exportPollInterval = null;
      }

      document.getElementById('exportPreview').classList.add('hidden');
      document.getElementById('exportProgress').classList.add('hidden');
      document.getElementById('exportComplete').classList.add('hidden');
      document.getElementById('previewExportBtn').disabled = false;
      document.getElementById('createExportBtn').disabled = true;
    }

    // 监听导出基准时间选择变化
    document.querySelectorAll('input[name="exportBase"]').forEach(radio => {
      radio.addEventListener('change', function() {
        const customTimeInput = document.getElementById('customExportTime');
        customTimeInput.disabled = this.value !== 'custom';
        if (this.value === 'custom') {
          customTimeInput.focus();
        }
      });
    });

    // 页面加载时刷新状态
    document.addEventListener('DOMContentLoaded', function() {
      refreshCacheStatus();
      loadExportHistory();
    });
  </script>
</body>
</html>`;
}
