/**
 * Import Web UI HTML 模板
 * 提供简单的管理界面用于导入差分包
 */

export function getImportUIHTML(config: any): string {
  const title = config?.title || 'Verdaccio Metadata Healer';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 导入管理</title>
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
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
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

    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }

    .card h2 {
      font-size: 18px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #28a745;
      color: #1e7e34;
    }

    .upload-area {
      border: 2px dashed #ccc;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 15px;
    }

    .upload-area:hover {
      border-color: #28a745;
      background: #f8fff8;
    }

    .upload-area.dragover {
      border-color: #28a745;
      background: #e8f5e9;
    }

    .upload-area.has-file {
      border-color: #28a745;
      background: #e8f5e9;
    }

    .upload-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }

    .upload-text {
      color: #666;
      margin-bottom: 10px;
    }

    .upload-hint {
      font-size: 12px;
      color: #999;
    }

    .file-info {
      display: none;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 6px;
      margin-bottom: 15px;
    }

    .file-info.visible {
      display: block;
    }

    .file-name {
      font-weight: 600;
      color: #28a745;
    }

    .file-size {
      color: #666;
      font-size: 14px;
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
      background: #28a745;
      color: white;
    }

    .btn-primary:hover {
      background: #218838;
    }

    .btn-danger {
      background: #dc3545;
      color: white;
    }

    .btn-danger:hover {
      background: #c82333;
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
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-weight: normal;
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
      background: #28a745;
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

    .progress-container {
      display: none;
      margin-top: 20px;
    }

    .progress-container.visible {
      display: block;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .progress-phase {
      font-weight: 600;
      color: #1e7e34;
    }

    .progress-percentage {
      font-size: 24px;
      font-weight: bold;
      color: #28a745;
    }

    .progress-bar {
      height: 12px;
      background: #e0e0e0;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #28a745, #20c997);
      transition: width 0.3s;
    }

    .progress-message {
      font-size: 13px;
      color: #666;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 5px;
    }

    .result-container {
      display: none;
      margin-top: 20px;
      padding: 20px;
      border-radius: 8px;
    }

    .result-container.visible {
      display: block;
    }

    .result-container.success {
      background: #e8f5e9;
      border: 1px solid #c8e6c9;
    }

    .result-container.error {
      background: #ffebee;
      border: 1px solid #ffcdd2;
    }

    .result-icon {
      font-size: 48px;
      text-align: center;
      margin-bottom: 10px;
    }

    .result-title {
      text-align: center;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 15px;
    }

    .result-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      margin-bottom: 15px;
    }

    .result-stat {
      text-align: center;
      padding: 10px;
      background: white;
      border-radius: 6px;
    }

    .result-stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #28a745;
    }

    .result-stat-label {
      font-size: 12px;
      color: #666;
    }

    .history-list {
      max-height: 300px;
      overflow-y: auto;
    }

    .history-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      border-bottom: 1px solid #eee;
    }

    .history-item:last-child {
      border-bottom: none;
    }

    .history-item:hover {
      background: #f8f9fa;
    }

    .history-name {
      font-weight: 500;
    }

    .history-info {
      font-size: 12px;
      color: #666;
    }

    .status-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-badge.success { background: #e8f5e9; color: #388e3c; }
    .status-badge.partial { background: #fff3e0; color: #f57c00; }
    .status-badge.failed { background: #ffebee; color: #d32f2f; }

    .log-container {
      background: #1e1e1e;
      color: #d4d4d4;
      border-radius: 5px;
      padding: 15px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      max-height: 200px;
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

    #fileInput {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📥 ${title}</h1>
      <p>离线 NPM 依赖管理 - 内网导入控制台</p>
    </header>

    <!-- 文件上传 -->
    <div class="card">
      <h2>📦 导入差分包</h2>
      <div class="upload-area" id="uploadArea" onclick="document.getElementById('fileInput').click()">
        <div class="upload-icon">📁</div>
        <div class="upload-text">点击或拖拽文件到此处</div>
        <div class="upload-hint">支持 .tar.gz 格式的差分导出包</div>
      </div>
      <input type="file" id="fileInput" accept=".tar.gz,.tgz">

      <div class="file-info" id="fileInfo">
        <span class="file-name" id="fileName"></span>
        <span class="file-size" id="fileSize"></span>
        <button class="btn btn-danger" onclick="clearFile()" style="float: right; padding: 5px 10px;">✕ 移除</button>
      </div>

      <div class="form-group">
        <label>导入选项</label>
        <div class="option-row">
          <label><input type="checkbox" id="overwrite"><span>覆盖已存在的文件</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">如果目标文件已存在，是否覆盖。默认跳过已存在的文件。</span></button>
        </div>
        <div class="option-row">
          <label><input type="checkbox" id="validateChecksum" checked><span>验证文件校验和</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">导入前验证每个文件的 SHA256 校验和，确保文件完整性。</span></button>
        </div>
        <div class="option-row">
          <label><input type="checkbox" id="rebuildMetadata" checked><span>自动重建元数据</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">导入后自动触发元数据重建，使新导入的包立即可用。</span></button>
        </div>
      </div>

      <button class="btn btn-primary" id="importBtn" onclick="startImport()" disabled>
        🚀 开始导入
      </button>

      <!-- 进度显示 -->
      <div class="progress-container" id="progressContainer">
        <div class="progress-header">
          <span class="progress-phase" id="progressPhase">准备中...</span>
          <span class="progress-percentage" id="progressPercentage">0%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar-fill" id="progressBar" style="width: 0%"></div>
        </div>
        <div class="progress-message" id="progressMessage">等待开始...</div>
      </div>

      <!-- 结果显示 -->
      <div class="result-container" id="resultContainer">
        <div class="result-icon" id="resultIcon">✅</div>
        <div class="result-title" id="resultTitle">导入完成</div>
        <div class="result-stats" id="resultStats"></div>
        <div style="text-align: center;">
          <button class="btn btn-primary" onclick="resetImport()">↩️ 继续导入</button>
        </div>
      </div>
    </div>

    <!-- 元数据同步 -->
    <div class="card">
      <h2>📋 元数据同步</h2>
      <p style="color: #666; margin-bottom: 15px;">从远端 registry 同步最新的包元数据到本地，更新 dist-tags（如 latest、next 等）</p>

      <div class="sync-actions" style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 15px;">
        <button class="btn btn-primary" id="syncAllBtn" onclick="startSyncAll()">
          🔄 刷新所有元数据
        </button>
        <button class="btn" style="background: #6c757d; color: white;" onclick="loadPackageList()">
          📦 查看本地包列表
        </button>
      </div>

      <!-- 单包同步 -->
      <div class="form-group">
        <label>同步单个包</label>
        <div style="display: flex; gap: 10px;">
          <input type="text" id="syncPackageName" placeholder="输入包名，如 @babel/core 或 lodash"
            style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px;">
          <button class="btn btn-primary" onclick="syncSinglePackage()">同步</button>
        </div>
      </div>

      <!-- 同步进度 -->
      <div class="sync-progress-container" id="syncProgressContainer" style="display: none; margin-top: 20px;">
        <div class="progress-header">
          <span class="progress-phase" id="syncProgressPhase">准备中...</span>
          <span class="progress-percentage" id="syncProgressPercentage">0%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar-fill" id="syncProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-message" id="syncProgressMessage">等待开始...</div>
      </div>

      <!-- 同步结果 -->
      <div class="sync-result-container" id="syncResultContainer" style="display: none; margin-top: 20px; padding: 15px; border-radius: 8px;">
        <div class="result-icon" id="syncResultIcon" style="font-size: 36px; text-align: center;">✅</div>
        <div class="result-title" id="syncResultTitle" style="text-align: center; font-size: 16px; font-weight: 600; margin: 10px 0;">同步完成</div>
        <div class="sync-result-stats" id="syncResultStats" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;"></div>
      </div>

      <!-- 包列表 -->
      <div class="package-list-container" id="packageListContainer" style="display: none; margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span style="font-weight: 600;">本地包列表 (<span id="packageCount">0</span> 个)</span>
          <button class="btn" style="background: #6c757d; color: white; padding: 5px 10px;" onclick="hidePackageList()">关闭</button>
        </div>
        <div class="package-list" id="packageList" style="max-height: 300px; overflow-y: auto; border: 1px solid #eee; border-radius: 5px;"></div>
      </div>
    </div>

    <!-- 导入历史 -->
    <div class="card">
      <h2>📜 导入历史</h2>
      <div class="history-list" id="historyList">
        <p style="color: #666; text-align: center; padding: 20px;">加载中...</p>
      </div>
    </div>

    <!-- 执行日志 -->
    <div class="card">
      <h2>📋 执行日志</h2>
      <div class="log-container" id="logContainer">
        <div class="log-entry info">
          <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
          系统就绪，等待上传文件...
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = '/_/healer/import';
    let selectedFile = null;
    let currentTaskId = null;
    let pollInterval = null;

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

    // 格式化文件大小
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    // 文件选择处理
    document.getElementById('fileInput').addEventListener('change', function(e) {
      if (e.target.files.length > 0) {
        selectFile(e.target.files[0]);
      }
    });

    // 拖拽处理
    const uploadArea = document.getElementById('uploadArea');

    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        selectFile(e.dataTransfer.files[0]);
      }
    });

    // 选择文件
    function selectFile(file) {
      if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
        addLog('只支持 .tar.gz 或 .tgz 文件', 'error');
        return;
      }

      selectedFile = file;
      document.getElementById('fileName').textContent = file.name;
      document.getElementById('fileSize').textContent = ' (' + formatSize(file.size) + ')';
      document.getElementById('fileInfo').classList.add('visible');
      document.getElementById('uploadArea').classList.add('has-file');
      document.getElementById('importBtn').disabled = false;
      addLog('已选择文件: ' + file.name, 'success');
    }

    // 清除文件
    function clearFile() {
      selectedFile = null;
      document.getElementById('fileInput').value = '';
      document.getElementById('fileInfo').classList.remove('visible');
      document.getElementById('uploadArea').classList.remove('has-file');
      document.getElementById('importBtn').disabled = true;
    }

    // 开始导入
    async function startImport() {
      if (!selectedFile) {
        addLog('请先选择文件', 'warning');
        return;
      }

      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('overwrite', document.getElementById('overwrite').checked);
      formData.append('validateChecksum', document.getElementById('validateChecksum').checked);
      formData.append('rebuildMetadata', document.getElementById('rebuildMetadata').checked);

      try {
        document.getElementById('importBtn').disabled = true;
        document.getElementById('progressContainer').classList.add('visible');
        document.getElementById('resultContainer').classList.remove('visible');
        addLog('正在上传文件...', 'info');

        const response = await fetch(API_BASE + '/upload', {
          method: 'POST',
          body: formData
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('导入任务已启动: ' + data.taskId, 'success');
          startPolling(data.taskId);
        } else {
          addLog('启动导入失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('importBtn').disabled = false;
        }
      } catch (error) {
        addLog('上传失败: ' + error.message, 'error');
        document.getElementById('importBtn').disabled = false;
      }
    }

    // 开始轮询状态
    function startPolling(taskId) {
      if (pollInterval) {
        clearInterval(pollInterval);
      }

      pollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateProgress(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(pollInterval);
            pollInterval = null;

            if (task.status === 'completed' && task.result) {
              addLog('导入完成: ' + task.result.imported + ' 个文件', 'success');
              showResult(task.result);
              loadHistory();
            } else {
              addLog('导入失败: ' + (task.error || '未知错误'), 'error');
              showError(task.error || '未知错误');
            }
          }
        } catch (error) {
          addLog('获取状态失败: ' + error.message, 'error');
        }
      }, 1000);
    }

    // 更新进度显示
    function updateProgress(task) {
      const progress = task.detailedProgress || {};
      const totalProgress = task.progress || progress.totalProgress || 0;

      const phaseLabels = {
        'uploading': '上传文件',
        'extracting': '解压文件',
        'validating': '验证校验和',
        'importing': '导入文件',
        'rebuilding': '重建元数据',
        'completed': '导入完成'
      };

      document.getElementById('progressPhase').textContent =
        phaseLabels[progress.phase] || progress.phaseDescription || '处理中...';
      document.getElementById('progressPercentage').textContent = totalProgress + '%';
      document.getElementById('progressBar').style.width = totalProgress + '%';
      document.getElementById('progressMessage').textContent =
        progress.currentFile || progress.phaseDescription || task.message || '处理中...';
    }

    // 显示结果
    function showResult(result) {
      document.getElementById('progressContainer').classList.remove('visible');
      document.getElementById('resultContainer').classList.add('visible');
      document.getElementById('resultContainer').classList.remove('error');
      document.getElementById('resultContainer').classList.add('success');

      document.getElementById('resultIcon').textContent = result.success ? '✅' : '⚠️';
      document.getElementById('resultTitle').textContent = result.success ? '导入完成' : '部分导入成功';

      document.getElementById('resultStats').innerHTML =
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.imported + '</div>' +
          '<div class="result-stat-label">已导入</div>' +
        '</div>' +
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.skipped + '</div>' +
          '<div class="result-stat-label">已跳过</div>' +
        '</div>' +
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.packages + '</div>' +
          '<div class="result-stat-label">包数</div>' +
        '</div>' +
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.versions + '</div>' +
          '<div class="result-stat-label">版本数</div>' +
        '</div>';
    }

    // 显示错误
    function showError(error) {
      document.getElementById('progressContainer').classList.remove('visible');
      document.getElementById('resultContainer').classList.add('visible');
      document.getElementById('resultContainer').classList.remove('success');
      document.getElementById('resultContainer').classList.add('error');

      document.getElementById('resultIcon').textContent = '❌';
      document.getElementById('resultTitle').textContent = '导入失败';
      document.getElementById('resultStats').innerHTML =
        '<p style="text-align: center; color: #d32f2f;">' + error + '</p>';
    }

    // 重置导入
    function resetImport() {
      clearFile();
      document.getElementById('progressContainer').classList.remove('visible');
      document.getElementById('resultContainer').classList.remove('visible');
      document.getElementById('importBtn').disabled = true;
      currentTaskId = null;
    }

    // 加载导入历史
    async function loadHistory() {
      try {
        const response = await fetch(API_BASE + '/history');
        const data = await response.json();

        const container = document.getElementById('historyList');
        if (!data.history || data.history.length === 0) {
          container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">暂无导入记录</p>';
          return;
        }

        const recentImports = data.history.slice(-10).reverse();
        container.innerHTML = recentImports.map(imp =>
          '<div class="history-item">' +
            '<div>' +
              '<div class="history-name">' + imp.filename + '</div>' +
              '<div class="history-info">' +
                new Date(imp.timestampMs).toLocaleString() + ' | ' +
                imp.summary.packages + ' 个包, ' + imp.summary.versions + ' 个版本' +
              '</div>' +
            '</div>' +
            '<span class="status-badge ' + imp.status + '">' + imp.status + '</span>' +
          '</div>'
        ).join('');
      } catch (error) {
        addLog('加载历史失败: ' + error.message, 'error');
      }
    }

    // 页面加载时加载历史
    document.addEventListener('DOMContentLoaded', function() {
      loadHistory();
    });

    // ==================== 元数据同步功能 ====================
    const SYNC_API_BASE = '/_/healer';
    let currentSyncTaskId = null;
    let syncPollInterval = null;

    // 开始同步所有包
    async function startSyncAll() {
      try {
        document.getElementById('syncAllBtn').disabled = true;
        document.getElementById('syncProgressContainer').style.display = 'block';
        document.getElementById('syncResultContainer').style.display = 'none';
        document.getElementById('packageListContainer').style.display = 'none';

        addLog('正在启动元数据同步任务...', 'info');

        const response = await fetch(SYNC_API_BASE + '/sync-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentSyncTaskId = data.taskId;
          addLog('同步任务已启动: ' + data.taskId + ' (' + data.totalPackages + ' 个包)', 'success');
          startSyncPolling(data.taskId);
        } else {
          addLog('启动同步失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('syncAllBtn').disabled = false;
        }
      } catch (error) {
        addLog('同步请求失败: ' + error.message, 'error');
        document.getElementById('syncAllBtn').disabled = false;
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
        addLog('正在同步 ' + packageName + '...', 'info');

        // 处理 scoped 包名
        let url = SYNC_API_BASE + '/sync/';
        if (packageName.startsWith('@')) {
          const parts = packageName.substring(1).split('/');
          url += parts[0] + '/' + parts[1];
        } else {
          url += packageName;
        }

        const response = await fetch(url, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
          addLog('同步成功: ' + packageName + ' (' + data.versionsCount + ' 个版本, latest: ' + (data.distTags?.latest || 'N/A') + ')', 'success');
        } else {
          addLog('同步失败: ' + packageName + ' - ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('同步请求失败: ' + error.message, 'error');
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
              const results = task.results || [];
              const successCount = results.filter(r => r.success).length;
              const failedCount = results.filter(r => !r.success).length;
              addLog('同步完成: ' + successCount + ' 成功, ' + failedCount + ' 失败', 'success');
              showSyncResult(task);
            } else {
              addLog('同步失败: ' + (task.error || '未知错误'), 'error');
              showSyncError(task.error || '未知错误');
            }
          }
        } catch (error) {
          addLog('获取同步状态失败: ' + error.message, 'error');
        }
      }, 1000);
    }

    // 更新同步进度
    function updateSyncProgress(task) {
      const progress = task.progress || 0;
      const current = task.current || 0;
      const total = task.total || 0;
      const currentPackage = task.currentPackage || '';

      document.getElementById('syncProgressPhase').textContent =
        task.status === 'running' ? '同步中 (' + current + '/' + total + ')' : '准备中...';
      document.getElementById('syncProgressPercentage').textContent = progress + '%';
      document.getElementById('syncProgressBar').style.width = progress + '%';
      document.getElementById('syncProgressMessage').textContent =
        currentPackage ? '正在同步: ' + currentPackage : '处理中...';
    }

    // 显示同步结果
    function showSyncResult(task) {
      document.getElementById('syncProgressContainer').style.display = 'none';
      document.getElementById('syncResultContainer').style.display = 'block';
      document.getElementById('syncResultContainer').style.background = '#e8f5e9';
      document.getElementById('syncResultContainer').style.border = '1px solid #c8e6c9';

      const results = task.results || [];
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;

      document.getElementById('syncResultIcon').textContent = failedCount === 0 ? '✅' : '⚠️';
      document.getElementById('syncResultTitle').textContent =
        failedCount === 0 ? '同步完成' : '同步完成（部分失败）';

      document.getElementById('syncResultStats').innerHTML =
        '<div class=\"result-stat\" style=\"text-align: center; padding: 10px; background: white; border-radius: 6px;\">' +
          '<div style=\"font-size: 24px; font-weight: bold; color: #28a745;\">' + successCount + '</div>' +
          '<div style=\"font-size: 12px; color: #666;\">成功</div>' +
        '</div>' +
        '<div class=\"result-stat\" style=\"text-align: center; padding: 10px; background: white; border-radius: 6px;\">' +
          '<div style=\"font-size: 24px; font-weight: bold; color: ' + (failedCount > 0 ? '#dc3545' : '#28a745') + ';\">' + failedCount + '</div>' +
          '<div style=\"font-size: 12px; color: #666;\">失败</div>' +
        '</div>';
    }

    // 显示同步错误
    function showSyncError(error) {
      document.getElementById('syncProgressContainer').style.display = 'none';
      document.getElementById('syncResultContainer').style.display = 'block';
      document.getElementById('syncResultContainer').style.background = '#ffebee';
      document.getElementById('syncResultContainer').style.border = '1px solid #ffcdd2';

      document.getElementById('syncResultIcon').textContent = '❌';
      document.getElementById('syncResultTitle').textContent = '同步失败';
      document.getElementById('syncResultStats').innerHTML =
        '<p style=\"text-align: center; color: #d32f2f; grid-column: span 2;\">' + error + '</p>';
    }

    // 加载包列表
    async function loadPackageList() {
      try {
        addLog('正在加载本地包列表...', 'info');
        const response = await fetch(SYNC_API_BASE + '/packages');
        const data = await response.json();

        if (data.success) {
          document.getElementById('packageCount').textContent = data.count;
          document.getElementById('packageListContainer').style.display = 'block';

          const packages = data.packages || [];
          if (packages.length === 0) {
            document.getElementById('packageList').innerHTML =
              '<p style=\"color: #666; text-align: center; padding: 20px;\">暂无本地包</p>';
          } else {
            document.getElementById('packageList').innerHTML = packages.map(pkg =>
              '<div style=\"display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #eee;\">' +
                '<span>' + pkg + '</span>' +
                '<button class=\"btn\" style=\"background: #28a745; color: white; padding: 3px 8px; font-size: 12px;\" onclick=\"syncPackageFromList(\\'' + pkg.replace(/'/g, \"\\\\'\") + '\\')\">同步</button>' +
              '</div>'
            ).join('');
          }
          addLog('已加载 ' + data.count + ' 个本地包', 'success');
        } else {
          addLog('加载包列表失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (error) {
        addLog('加载包列表失败: ' + error.message, 'error');
      }
    }

    // 隐藏包列表
    function hidePackageList() {
      document.getElementById('packageListContainer').style.display = 'none';
    }

    // 从列表同步单个包
    async function syncPackageFromList(packageName) {
      document.getElementById('syncPackageName').value = packageName;
      await syncSinglePackage();
    }
  </script>
</body>
</html>`;
}
