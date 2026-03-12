<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ElMessage } from 'element-plus';

import { useAuthSession } from '../stores/authSession';
import { authorizedJsonRequest } from '../utils/apiClient';

const auth = useAuthSession();

const loading = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);
const selectedRecord = ref(null);
const records = ref([]);
const pagination = reactive({
  page: 1,
  pageSize: 8,
  total: 0,
});
const filters = reactive({
  keyword: '',
  aircraftRegNo: '',
  status: '',
});

const statusOptions = [
  { label: '全部记录', value: '' },
  { label: '待审核', value: 'submitted' },
  { label: '待放行', value: 'peer_checked,rii_approved' },
  { label: '已驳回', value: 'rejected' },
  { label: '已放行', value: 'released' },
];

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
    revoked: '已作废',
    draft: '草稿',
  };
  return mapping[status] || status || '-';
}

async function fetchRecords() {
  if (!canLoad.value) {
    return;
  }

  try {
    loading.value = true;
    const params = new URLSearchParams({
      page: String(pagination.page),
      pageSize: String(pagination.pageSize),
    });
    if (filters.keyword) {
      params.set('keyword', filters.keyword);
    }
    if (filters.aircraftRegNo) {
      params.set('aircraftRegNo', filters.aircraftRegNo);
    }
    if (filters.status) {
      // 支持逗号分隔的多状态筛选
      params.set('statuses', filters.status);
    }

    const data = await authorizedJsonRequest(
      auth.loginResult.value.token,
      `/api/maintenance/records?${params.toString()}`,
      { method: 'GET' },
    );

    records.value = data.rows || [];
    pagination.total = data.total || 0;
  } catch (error) {
    ElMessage.error(error.message || '加载记录失败');
  } finally {
    loading.value = false;
  }
}

async function openRecordDetail(recordId) {
  if (!canLoad.value) {
    return;
  }

  try {
    detailVisible.value = true;
    detailLoading.value = true;
    selectedRecord.value = await authorizedJsonRequest(
      auth.loginResult.value.token,
      `/api/maintenance/records/${recordId}`,
      { method: 'GET' },
    );
  } catch (error) {
    detailVisible.value = false;
    ElMessage.error(error.message || '加载记录详情失败');
  } finally {
    detailLoading.value = false;
  }
}

function setStatusFilter(value) {
  filters.status = value;
  pagination.page = 1;
  fetchRecords();
}

onMounted(() => {
  fetchRecords();
});
</script>

<template>
  <div v-if="!canLoad" class="result-block">
    <el-alert
      type="warning"
      :closable="false"
      title="请先登录后再进入查阅中心"
      description="当前页面需要真实 JWT 才能查询检修记录列表和详情。"
    />
    <div class="button-row top-gap">
      <RouterLink to="/auth" class="workspace-auth-link">前往认证页</RouterLink>
    </div>
  </div>

  <div v-else class="module-stack">
    <section class="module-panel">
      <div class="module-header-row">
        <div>
          <div class="module-title">查阅中心</div>
          <div class="module-subtitle">记录列表、状态筛选和详情抽屉都已经接到真实后端接口。</div>
        </div>
        <div class="filter-pills">
          <button
            v-for="option in statusOptions"
            :key="option.value || 'all'"
            class="filter-pill button-pill"
            :class="{ 'is-active': filters.status === option.value }"
            @click="setStatusFilter(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="form-grid record-filter-grid">
        <el-input v-model="filters.keyword" placeholder="搜索记录号、工卡号、工作类型、工号" clearable />
        <el-input v-model="filters.aircraftRegNo" placeholder="按机号过滤，例如 B-4321" clearable />
        <div class="button-row no-top-gap">
          <el-button type="primary" :loading="loading" @click="fetchRecords">查询</el-button>
        </div>
      </div>

      <div v-loading="loading" class="records-table-shell">
        <div class="records-table-row records-table-head records-table-row-wide">
          <span>记录号</span>
          <span>机号</span>
          <span>工作类型</span>
          <span>版本</span>
          <span>状态</span>
          <span>签名进度</span>
          <span>更新时间</span>
          <span>操作</span>
        </div>

        <div v-for="row in records" :key="row.recordId" class="records-table-row records-table-row-wide">
          <span class="mono">{{ row.recordId }}</span>
          <span>{{ row.aircraftRegNo }}</span>
          <span>{{ row.workType }}</span>
          <span>R{{ row.revision }}</span>
          <span><span class="status-chip">{{ statusLabel(row.status) }}</span></span>
          <span>{{ row.reviewerSignatureCount }}/{{ row.requiredReviewerSignatures }}</span>
          <span>{{ formatDateTime(row.updatedAt) }}</span>
          <span>
            <el-button text type="primary" @click="openRecordDetail(row.recordId)">查看详情</el-button>
          </span>
        </div>

        <div v-if="records.length === 0 && !loading" class="module-empty-state">
          当前条件下没有检修记录。
        </div>
      </div>
    </section>

    <section class="module-panel accent-panel">
      <div class="module-title">分页结果</div>
      <div class="module-subtitle">当前第 {{ pagination.page }} 页，共 {{ pagination.total }} 条记录。后续可继续接服务器端分页组件。</div>
    </section>

    <el-drawer v-model="detailVisible" size="46%" title="检修记录详情">
      <div v-if="selectedRecord" v-loading="detailLoading" class="module-stack">
        <section class="module-panel">
          <div class="module-title">基础信息</div>
          <div class="detail-grid two-up-grid">
            <div class="detail-item"><span>记录号</span><strong class="mono">{{ selectedRecord.recordId }}</strong></div>
            <div class="detail-item"><span>工卡号</span><strong>{{ selectedRecord.jobCardNo }}</strong></div>
            <div class="detail-item"><span>机号</span><strong>{{ selectedRecord.aircraftRegNo }}</strong></div>
            <div class="detail-item"><span>状态</span><strong>{{ statusLabel(selectedRecord.status) }}</strong></div>
            <div class="detail-item"><span>执行人</span><strong>{{ selectedRecord.performerEmployeeNo }}</strong></div>
            <div class="detail-item"><span>工作类型</span><strong>{{ selectedRecord.workType }}</strong></div>
          </div>
        </section>

        <section class="module-panel">
          <div class="module-title">指定签名人</div>
          <div v-if="selectedRecord.specifiedSigners.length === 0" class="module-empty-state">当前记录没有配置指定签名人。</div>
          <div v-else class="tag-flow">
            <span v-for="signer in selectedRecord.specifiedSigners" :key="`${signer.signerRole}-${signer.signerEmployeeNo}`" class="filter-pill is-active">
              {{ signer.signerRole }} / {{ signer.signerEmployeeNo }} / {{ signer.status }}
            </span>
          </div>
        </section>

        <section class="module-panel">
          <div class="module-title">Revision 时间线</div>
          <div class="timeline-stack">
            <div v-for="revision in selectedRecord.revisions" :key="revision.recordId" class="timeline-item">
              <strong>R{{ revision.revision }}</strong>
              <span>{{ statusLabel(revision.status) }}</span>
              <span>{{ formatDateTime(revision.createdAt) }}</span>
            </div>
          </div>
        </section>
      </div>
    </el-drawer>
  </div>
</template>