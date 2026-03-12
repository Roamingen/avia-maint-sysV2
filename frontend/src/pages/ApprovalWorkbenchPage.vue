<script setup>
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ethers } from 'ethers';

import { useAuthSession } from '../stores/authSession';
import { authorizedJsonRequest } from '../utils/apiClient';

const auth = useAuthSession();

const loading = ref(false);
const workbench = ref({
  summary: {
    totalRecords: 0,
    pendingReviewCount: 0,
    pendingReleaseCount: 0,
    rejectedCount: 0,
    releasedCount: 0,
  },
  queues: {
    review: [],
    release: [],
    rejected: [],
    recent: [],
  },
});

const canLoad = computed(() => auth.isLoggedIn.value && auth.loginResult.value?.token);

function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  return String(value).replace('T', ' ').slice(0, 19);
}

function statusLabel(status) {
  const mapping = {
    submitted: '待审核',
    peer_checked: '待放行',
    rii_approved: '待放行',
    released: '已放行',
    rejected: '已驳回',
  };
  return mapping[status] || status || '-';
}

async function fetchWorkbench() {
  if (!canLoad.value) {
    return;
  }

  try {
    loading.value = true;
    const result = await authorizedJsonRequest(
      auth.loginResult.value.token,
      '/api/maintenance/workbench',
      { method: 'GET' },
    );
    
    console.log('=== 工作台数据返回 ===');
    console.log('审核队列:', result.queues.review.length, '条');
    if (result.queues.review.length > 0) {
      result.queues.review.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.aircraftRegNo} - ${item.status}`);
      });
    }
    console.log('放行队列:', result.queues.release.length, '条');
    if (result.queues.release.length > 0) {
      result.queues.release.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.aircraftRegNo} - ${item.status}`);
      });
    }
    
    workbench.value = result;
  } catch (error) {
    ElMessage.error(error.message || '加载审批工作台失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchWorkbench();
});

function buildDigest(recordId, action, hashes, signerEmployeeNo) {
  const digestObject = {
    recordId,
    action,
    formHash: hashes.formHash,
    attachmentManifestHash: hashes.attachmentManifestHash,
    signerEmployeeNo,
  };
  
  const sortedKeys = Object.keys(digestObject).sort();
  const canonicalJson = `{${sortedKeys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(digestObject[key])}`).join(',')}}`;
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
}

async function executeAction(record, signerRole, action, withReason = false) {
  if (!window.ethereum) {
    ElMessage.error('请先安装 MetaMask');
    return;
  }

  try {
    let rejectionReason = null;
    if (withReason) {
      const result = await ElMessageBox.prompt('请输入驳回原因', '驳回记录', {
        confirmButtonText: '确认驳回',
        cancelButtonText: '取消',
        inputPlaceholder: '请输入驳回原因',
        inputValidator: (value) => {
          if (!value || !value.trim()) {
            return '驳回原因不能为空';
          }
          return true;
        },
      });
      rejectionReason = result.value.trim();
    }

    loading.value = true;
    const fullRecord = await authorizedJsonRequest(
      auth.loginResult.value.token,
      `/api/maintenance/records/${record.recordId}`,
      { method: 'GET' },
    );

    console.log('=== 审批操作详情 ===');
    console.log('记录 ID:', fullRecord.recordId);
    console.log('飞机注册号:', fullRecord.aircraftRegNo);
    console.log('当前状态:', fullRecord.status);
    console.log('技术签名:', `${fullRecord.technicianSignatureCount}/${fullRecord.requiredTechnicianSignatures}`);
    console.log('审核签名:', `${fullRecord.reviewerSignatureCount}/${fullRecord.requiredReviewerSignatures}`);
    console.log('是否 RII:', fullRecord.isRII);
    console.log('已有签名:', fullRecord.signatures.length, '个');
    if (fullRecord.signatures.length > 0) {
      console.log('签名详情:');
      fullRecord.signatures.forEach((sig, idx) => {
        console.log(`  ${idx + 1}. ${sig.signerEmployeeNo} - ${sig.action} (${sig.signerRole})`);
      });
    }
    if (fullRecord.specifiedSigners && fullRecord.specifiedSigners.length > 0) {
      console.log('指定签名人:', fullRecord.specifiedSigners.length, '人');
      fullRecord.specifiedSigners.forEach((signer, idx) => {
        console.log(`  ${idx + 1}. ${signer.signerEmployeeNo} - ${signer.signerRole} - ${signer.status}`);
      });
    }

    const currentUser = auth.latestLoggedInUser.value;
    console.log('当前用户:', currentUser.employeeNo);
    console.log('当前地址:', currentUser.address);
    console.log('签名角色:', signerRole);
    console.log('签名动作:', action);

    // 检查是否已经签过名
    const alreadySigned = fullRecord.signatures.some(
      sig => sig.action === action && sig.signerEmployeeNo === currentUser.employeeNo
    );
    if (alreadySigned) {
      ElMessage.warning(`您（${currentUser.employeeNo}）已经对此记录执行过 ${action} 操作，不能重复签名`);
      return;
    }

    // 检查签名数量是否已满
    if (action === 'reviewer_sign' && fullRecord.reviewerSignatureCount >= fullRecord.requiredReviewerSignatures) {
      ElMessage.warning(`审核签名数量已满足（${fullRecord.reviewerSignatureCount}/${fullRecord.requiredReviewerSignatures}），请直接进行放行操作`);
      return;
    }

    const signedDigest = buildDigest(fullRecord.recordId, action, fullRecord.hashes, currentUser.employeeNo);
    console.log('签名摘要:', signedDigest);

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const signerAddress = await signer.getAddress();
    console.log('MetaMask 地址:', signerAddress);

    if (signerAddress.toLowerCase() !== currentUser.address.toLowerCase()) {
      ElMessage.error(`MetaMask 地址（${signerAddress}）与登录用户地址（${currentUser.address}）不一致，请切换 MetaMask 账户`);
      return;
    }

    const signature = await signer.signMessage(ethers.getBytes(signedDigest));
    console.log('签名完成，准备提交...');

    const payload = {
      signerRole,
      action,
      signedDigest,
      signature,
    };
    if (rejectionReason) {
      payload.rejectionReason = rejectionReason;
    }

    await authorizedJsonRequest(
      auth.loginResult.value.token,
      `/api/maintenance/records/${record.recordId}/signatures`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );

    console.log('✅ 签名提交成功');
    ElMessage.success(`${action === 'reject' ? '驳回' : action === 'release' ? '放行' : '审核'}成功`);
    
    console.log('=== 开始刷新工作台数据 ===');
    await fetchWorkbench();
    console.log('=== 工作台数据刷新完成 ===');
    console.log('审核队列记录数:', workbench.value.queues.review.length);
    console.log('放行队列记录数:', workbench.value.queues.release.length);
  } catch (error) {
    if (error !== 'cancel') {
      console.error('=== 操作失败 ===');
      console.error(error);
      
      let errorMessage = error.message || `${action} 操作失败`;
      
      // 解析区块链错误信息
      if (errorMessage.includes('CALL_EXCEPTION')) {
        if (errorMessage.includes('Not enough reviewer signatures')) {
          errorMessage = '审核签名数量不足，无法完成此操作';
        } else if (errorMessage.includes('Not enough technician signatures')) {
          errorMessage = '技术签名数量不足，无法完成此操作';
        } else if (errorMessage.includes('Reviewer sign not allowed')) {
          errorMessage = '当前记录状态不允许审核签名';
        } else if (errorMessage.includes('Release not allowed')) {
          errorMessage = '当前记录状态不允许放行';
        } else if (errorMessage.includes('Reject not allowed')) {
          errorMessage = '当前记录状态不允许驳回';
        } else if (errorMessage.includes('Signer already used this action')) {
          errorMessage = '您已经对此记录执行过该操作，不能重复签名';
        } else {
          errorMessage = '区块链合约调用失败，请检查记录状态和签名条件';
        }
      }
      
      ElMessage.error(errorMessage);
    }
  } finally {
    loading.value = false;
  }
}

async function handleReview(record) {
  // 预检查
  if (record.status !== 'submitted') {
    ElMessage.warning(`记录状态为 ${record.status}，不能进行审核签名`);
    return;
  }
  
  await executeAction(record, 'reviewer', 'reviewer_sign', false);
}

async function handleReject(record) {
  await executeAction(record, 'reviewer', 'reject', true);
}

async function handleRelease(record) {
  await executeAction(record, 'release_authority', 'release', false);
}
</script>

<template>
  <div v-if="!canLoad" class="result-block">
    <el-alert
      type="warning"
      :closable="false"
      title="请先登录后再进入审批工作台"
      description="当前页面需要真实 JWT 和记录查看权限。"
    />
    <div class="button-row top-gap">
      <RouterLink to="/auth" class="workspace-auth-link">前往认证页</RouterLink>
    </div>
  </div>

  <div v-else class="module-stack" v-loading="loading">
    <section class="module-grid card-grid-three approval-summary-grid">
      <article class="module-panel primary-summary-card">
        <div class="module-title light-title">总记录数</div>
        <div class="member-card-count light-count">{{ workbench.summary.totalRecords }}</div>
        <div class="module-subtitle light-copy">全量检修记录规模</div>
      </article>
      <article class="module-panel member-card">
        <div class="module-title">待审核</div>
        <div class="member-card-count">{{ workbench.summary.pendingReviewCount }}</div>
        <div class="module-subtitle">当前处于 submitted</div>
      </article>
      <article class="module-panel member-card">
        <div class="module-title">待放行</div>
        <div class="member-card-count">{{ workbench.summary.pendingReleaseCount }}</div>
        <div class="module-subtitle">当前处于 peer_checked / rii_approved</div>
      </article>
    </section>

    <section class="module-grid two-up-grid">
      <article class="module-panel">
        <div class="module-title">审核队列</div>
        <div v-if="workbench.queues.review.length === 0" class="module-empty-state">当前没有待审核记录。</div>
        <div v-else class="queue-stack">
          <div v-for="item in workbench.queues.review" :key="item.recordId" class="queue-card">
            <div class="queue-card-head">
              <strong>{{ item.aircraftRegNo }}</strong>
              <span class="status-chip">{{ statusLabel(item.status) }}</span>
            </div>
            <div class="queue-card-copy">{{ item.workType }} / {{ item.ataCode }}</div>
            <div class="queue-card-foot">{{ item.performerEmployeeNo }} · {{ formatDateTime(item.updatedAt) }}</div>
            <div class="queue-card-actions">
              <el-button size="small" type="success" @click="handleReview(item)">审核通过</el-button>
              <el-button size="small" type="danger" @click="handleReject(item)">驳回</el-button>
            </div>
          </div>
        </div>
      </article>

      <article class="module-panel accent-panel">
        <div class="module-title">放行队列</div>
        <div v-if="workbench.queues.release.length === 0" class="module-empty-state">当前没有待放行记录。</div>
        <div v-else class="queue-stack">
          <div v-for="item in workbench.queues.release" :key="item.recordId" class="queue-card">
            <div class="queue-card-head">
              <strong>{{ item.aircraftRegNo }}</strong>
            <div class="queue-card-actions">
              <el-button size="small" type="primary" @click="handleRelease(item)">放行</el-button>
            </div>
              <span class="status-chip">{{ statusLabel(item.status) }}</span>
            </div>
            <div class="queue-card-copy">{{ item.workType }} / 审核 {{ item.reviewerSignatureCount }}/{{ item.requiredReviewerSignatures }}</div>
            <div class="queue-card-foot">{{ formatDateTime(item.updatedAt) }}</div>
          </div>
        </div>
      </article>
    </section>

    <section class="module-grid two-up-grid">
      <article class="module-panel">
        <div class="module-title">驳回处理</div>
        <div v-if="workbench.queues.rejected.length === 0" class="module-empty-state">当前没有已驳回记录。</div>
        <div v-else class="queue-stack">
          <div v-for="item in workbench.queues.rejected" :key="item.recordId" class="queue-card muted-card">
            <div class="queue-card-head">
              <strong>{{ item.recordId }}</strong>
              <span class="status-chip">{{ statusLabel(item.status) }}</span>
            </div>
            <div class="queue-card-copy">{{ item.rejectionReason || '等待补充说明并重提 revision' }}</div>
          </div>
        </div>
      </article>

      <article class="module-panel">
        <div class="module-title">最近活动</div>
        <div class="timeline-stack">
          <div v-for="item in workbench.queues.recent" :key="item.recordId" class="timeline-item">
            <strong>{{ item.aircraftRegNo }}</strong>
            <span>{{ item.workType }}</span>
            <span>{{ formatDateTime(item.updatedAt) }}</span>
          </div>
        </div>
      </article>
    </section>
  </div>
</template>