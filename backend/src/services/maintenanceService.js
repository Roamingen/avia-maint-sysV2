const crypto = require('crypto');
const { ethers } = require('ethers');

const { getPool } = require('../config/database');
const maintenanceStore = require('../models/maintenanceStore');
const userStore = require('../models/userStore');
const { hashJson } = require('../../scripts/chain_helpers');
const maintenanceChainService = require('./maintenanceChainService');

const STATUS_ALLOWED_FOR_RESUBMIT = new Set(['rejected']);
const SIGN_ACTIONS = new Set([
    'technician_sign',
    'reviewer_sign',
    'rii_approve',
    'release',
    'reject',
    'revoke',
]);
const SPECIFIED_SIGNER_ROLES = new Set([
    'technician',
    'reviewer',
    'rii_inspector',
    'release_authority',
]);
const ACTION_ROLE_MAPPING = {
    technician_sign: 'technician',
    reviewer_sign: 'reviewer',
    reject: 'reviewer',
    rii_approve: 'rii_inspector',
    release: 'release_authority',
};

function createError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeAddress(address) {
    return String(address || '').trim().toLowerCase();
}

function normalizeString(value) {
    return String(value || '').trim();
}

function normalizeOptionalString(value) {
    const normalized = normalizeString(value);
    return normalized || null;
}

function normalizeRole(value) {
    return normalizeString(value).toLowerCase();
}

function normalizeAction(value) {
    return normalizeString(value).toLowerCase();
}

function ensureValidSpecifiedSignerRole(role, label) {
    if (!SPECIFIED_SIGNER_ROLES.has(role)) {
        throw createError(`${label}不支持`, 400);
    }
}

function assertRequiredString(value, label) {
    if (!normalizeString(value)) {
        throw createError(`${label}不能为空`, 400);
    }
}

function assertBytes32Hex(value, label) {
    const normalized = normalizeString(value);
    if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
        throw createError(`${label}必须是 32 字节十六进制字符串`, 400);
    }
    return normalized;
}

function assertPositiveInteger(value, label, defaultValue = null) {
    if (value == null || value === '') {
        if (defaultValue != null) {
            return defaultValue;
        }
        throw createError(`${label}不能为空`, 400);
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw createError(`${label}必须是非负整数`, 400);
    }
    return parsed;
}

function toDateOrNull(value, label) {
    if (value == null || value === '') {
        return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw createError(`${label}格式不合法`, 400);
    }
    return parsed;
}

function requireArray(value, label, fallback = []) {
    if (value == null) {
        return fallback;
    }
    if (!Array.isArray(value)) {
        throw createError(`${label}必须是数组`, 400);
    }
    return value;
}

function dedupeSpecifiedSigners(signers) {
    const uniqueSigners = [];
    const seenKeys = new Set();

    for (const signer of signers) {
        const key = `${signer.signerRole}:${signer.signerEmployeeNo}`;
        if (seenKeys.has(key)) {
            throw createError(`指定签名人员重复: ${key}`, 400);
        }
        seenKeys.add(key);
        uniqueSigners.push(signer);
    }

    return uniqueSigners;
}

async function resolveSpecifiedSigners(specifiedSignersInput, previousSpecifiedSigners = []) {
    const sourceSigners = specifiedSignersInput != null
        ? requireArray(specifiedSignersInput, 'specifiedSigners')
        : requireArray(previousSpecifiedSigners, 'previousSpecifiedSigners', []);

    const normalizedSigners = [];
    for (let index = 0; index < sourceSigners.length; index += 1) {
        const item = sourceSigners[index] || {};
        const signerRole = normalizeRole(item.signerRole);
        const signerEmployeeNo = normalizeString(item.employeeNo || item.signerEmployeeNo);
        ensureValidSpecifiedSignerRole(signerRole, `specifiedSigners[${index}].signerRole`);
        assertRequiredString(signerEmployeeNo, `specifiedSigners[${index}].employeeNo`);

        const user = await userStore.findByEmployeeNo(signerEmployeeNo);
        if (!user) {
            throw createError(`指定签名人工号不存在: ${signerEmployeeNo}`, 400);
        }
        if (user.status !== 'active') {
            throw createError(`指定签名人未激活，不能参与签名: ${signerEmployeeNo}`, 409);
        }

        normalizedSigners.push({
            signerRole,
            signerUserId: user.id,
            signerEmployeeNo: user.employeeNo,
            signerName: user.name,
            isRequired: item.isRequired == null ? true : Boolean(item.isRequired),
            sequenceNo: assertPositiveInteger(item.sequenceNo, `specifiedSigners[${index}].sequenceNo`, index),
            status: item.status || 'pending',
            signedSignatureId: item.signedSignatureId || null,
            signedAt: item.signedAt || null,
        });
    }

    return dedupeSpecifiedSigners(normalizedSigners)
        .sort((left, right) => left.sequenceNo - right.sequenceNo || left.signerEmployeeNo.localeCompare(right.signerEmployeeNo));
}

function validateSpecifiedSignerCoverage(record) {
    const specifiedSigners = Array.isArray(record.specifiedSigners) ? record.specifiedSigners : [];
    if (specifiedSigners.length === 0) {
        return;
    }

    const technicians = specifiedSigners.filter((item) => item.signerRole === 'technician');
    const reviewers = specifiedSigners.filter((item) => item.signerRole === 'reviewer');
    const requiredAdditionalTechnicians = Math.max(record.requiredTechnicianSignatures - 1, 0);

    if (reviewers.length > 0 && reviewers.length < record.requiredReviewerSignatures) {
        throw createError('指定审核签名人数少于当前审核门槛', 400);
    }
    if (technicians.length > 0 && technicians.length < requiredAdditionalTechnicians) {
        throw createError('指定技术签名人数少于当前技术签名门槛所需的额外人数', 400);
    }
}

function getSpecifiedSignersForRole(record, signerRole) {
    return (record.specifiedSigners || []).filter((item) => item.signerRole === signerRole);
}

function ensureActionMatchesRole(action, signerRole) {
    const expectedRole = ACTION_ROLE_MAPPING[action];
    if (expectedRole && signerRole !== expectedRole) {
        throw createError(`动作 ${action} 必须由 ${expectedRole} 执行`, 400);
    }
}

function ensureCurrentUserIsSpecifiedSigner(record, signerRole, currentUser) {
    const roleSigners = getSpecifiedSignersForRole(record, signerRole);
    if (roleSigners.length === 0) {
        return;
    }

    const matchedSigner = roleSigners.find((item) => item.signerEmployeeNo === currentUser.employeeNo);
    if (!matchedSigner) {
        throw createError(`当前用户不在 ${signerRole} 指定签名名单内`, 403);
    }
    if (matchedSigner.status === 'cancelled') {
        throw createError('当前用户的指定签名资格已被取消', 409);
    }
}

function assertUserHasAnyPermission(user, permissionCodes, message = '权限不足') {
    const normalizedPermissions = Array.isArray(permissionCodes) ? permissionCodes : [permissionCodes];
    const allowed = normalizedPermissions.some((permissionCode) => user.permissions.includes(permissionCode));
    if (!allowed) {
        throw createError(message, 403);
    }
}

function generateRecordId(jobCardNo, revision) {
    return ethers.id(`${jobCardNo}:${revision}:${Date.now()}:${crypto.randomUUID()}`);
}

function generateJobCardNo() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const randomSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    return `AUTO-${year}${month}${day}-${randomSuffix}`;
}

function buildFormPayload(record) {
    return {
        aircraftRegNo: record.aircraftRegNo,
        aircraftType: record.aircraftType,
        jobCardNo: record.jobCardNo,
        revision: record.revision,
        ataCode: record.ataCode,
        workType: record.workType,
        locationCode: record.locationCode,
        performerEmployeeNo: record.performerEmployeeNo,
        performerName: record.performerName,
        occurrenceTime: record.occurrenceTime ? new Date(record.occurrenceTime).toISOString() : null,
        workDescription: record.payload.workDescription,
        referenceDocument: record.payload.referenceDocument,
        rawFormJson: record.payload.rawFormJson || {},
        normalizedFormJson: record.payload.normalizedFormJson,
    };
}

function buildFaultPayload(record) {
    return {
        faultCode: record.payload.faultCode,
        faultDescription: record.payload.faultDescription,
    };
}

function buildActionDigest(recordId, action, hashes, signerEmployeeNo) {
    return hashJson({
        recordId,
        action,
        formHash: hashes.formHash,
        attachmentManifestHash: hashes.attachmentManifestHash,
        signerEmployeeNo,
    });
}

function ensureSignatureMatchesAddress(signedDigest, signature, expectedAddress) {
    if (!signedDigest) {
        throw createError('signedDigest不能为空', 400);
    }
    if (!signature) {
        throw createError('signature不能为空', 400);
    }

    let recoveredAddress;
    try {
        recoveredAddress = normalizeAddress(
            ethers.verifyMessage(ethers.getBytes(signedDigest), signature)
        );
    } catch (error) {
        throw createError('签名格式不合法', 400);
    }

    if (recoveredAddress !== normalizeAddress(expectedAddress)) {
        throw createError('签名地址与当前登录用户不一致', 401);
    }
}

function normalizeAttachmentType(value) {
    const normalized = normalizeRole(value);
    if (!normalized) {
        return 'other';
    }
    if (['document', 'image', 'video', 'other'].includes(normalized)) {
        return normalized;
    }
    return 'other';
}

function normalizeStorageDisk(value) {
    const normalized = normalizeRole(value);
    if (!normalized) {
        return 'local';
    }
    if (['local', 'nas', 'minio', 's3', 'other'].includes(normalized)) {
        return normalized;
    }
    return 'other';
}

function normalizeUploadStatus(value) {
    const normalized = normalizeRole(value);
    if (!normalized) {
        return 'ready';
    }
    if (['pending', 'ready', 'quarantined', 'deleted'].includes(normalized)) {
        return normalized;
    }
    return 'ready';
}

function normalizeParts(parts) {
    return requireArray(parts, 'parts').map((part, index) => {
        assertRequiredString(part.partRole, `parts[${index}].partRole`);
        assertRequiredString(part.partNumber, `parts[${index}].partNumber`);
        return {
            partRole: normalizeRole(part.partRole),
            partNumber: normalizeString(part.partNumber),
            serialNumber: normalizeOptionalString(part.serialNumber),
            partStatus: normalizeOptionalString(part.partStatus),
            sourceDescription: normalizeOptionalString(part.sourceDescription),
            replacementReason: normalizeOptionalString(part.replacementReason),
            sortOrder: assertPositiveInteger(part.sortOrder, `parts[${index}].sortOrder`, index),
        };
    });
}

function normalizeMeasurements(measurements) {
    return requireArray(measurements, 'measurements').map((measurement, index) => {
        assertRequiredString(measurement.testItemName, `measurements[${index}].testItemName`);
        return {
            testItemName: normalizeString(measurement.testItemName),
            measuredValues: normalizeOptionalString(measurement.measuredValues),
            isPass: Boolean(measurement.isPass),
            sortOrder: assertPositiveInteger(measurement.sortOrder, `measurements[${index}].sortOrder`, index),
        };
    });
}

function normalizeReplacements(replacements) {
    return requireArray(replacements, 'replacements').map((replacement, index) => ({
        removedPartNo: normalizeOptionalString(replacement.removedPartNo),
        removedSerialNo: normalizeOptionalString(replacement.removedSerialNo),
        removedStatus: normalizeOptionalString(replacement.removedStatus),
        installedPartNo: normalizeOptionalString(replacement.installedPartNo),
        installedSerialNo: normalizeOptionalString(replacement.installedSerialNo),
        installedSource: normalizeOptionalString(replacement.installedSource),
        replacementReason: normalizeOptionalString(replacement.replacementReason),
        sortOrder: assertPositiveInteger(replacement.sortOrder, `replacements[${index}].sortOrder`, index),
    }));
}

function normalizeManifest(manifest, fallbackAttachments = []) {
    const manifestObject = manifest && typeof manifest === 'object' ? manifest : {};
    const attachments = requireArray(
        manifestObject.attachments,
        'manifest.attachments',
        fallbackAttachments
    ).map((attachment, index) => {
        assertRequiredString(attachment.attachmentId, `manifest.attachments[${index}].attachmentId`);
        assertRequiredString(attachment.fileName, `manifest.attachments[${index}].fileName`);
        assertRequiredString(attachment.mimeType, `manifest.attachments[${index}].mimeType`);
        assertRequiredString(attachment.storagePath, `manifest.attachments[${index}].storagePath`);

        return {
            attachmentId: normalizeString(attachment.attachmentId),
            attachmentType: normalizeAttachmentType(attachment.attachmentType || attachment.type),
            categoryCode: normalizeOptionalString(attachment.categoryCode),
            fileName: normalizeString(attachment.fileName),
            originalFileName: normalizeOptionalString(attachment.originalFileName),
            mimeType: normalizeString(attachment.mimeType),
            fileExtension: normalizeOptionalString(attachment.fileExtension),
            fileSize: assertPositiveInteger(attachment.fileSize || attachment.size, `manifest.attachments[${index}].fileSize`, 0),
            contentHash: normalizeString(attachment.contentHash),
            thumbnailHash: normalizeOptionalString(attachment.thumbnailHash),
            storageDisk: normalizeStorageDisk(attachment.storageDisk),
            storagePath: normalizeString(attachment.storagePath),
            previewPath: normalizeOptionalString(attachment.previewPath),
            transcodedPath: normalizeOptionalString(attachment.transcodedPath),
            uploadStatus: normalizeUploadStatus(attachment.uploadStatus),
            uploadedBy: attachment.uploadedBy || null,
            uploadedAt: toDateOrNull(attachment.uploadedAt, `manifest.attachments[${index}].uploadedAt`) || new Date(),
        };
    });

    const counts = {
        attachmentCount: attachments.length,
        documentCount: attachments.filter((item) => item.attachmentType === 'document').length,
        imageCount: attachments.filter((item) => item.attachmentType === 'image').length,
        videoCount: attachments.filter((item) => item.attachmentType === 'video').length,
        otherCount: attachments.filter((item) => item.attachmentType === 'other').length,
        totalSize: attachments.reduce((sum, item) => sum + item.fileSize, 0),
    };

    const manifestJson = {
        version: manifestObject.version || 1,
        generatedAt: manifestObject.generatedAt || new Date().toISOString(),
        attachments: attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            attachmentType: attachment.attachmentType,
            categoryCode: attachment.categoryCode,
            fileName: attachment.fileName,
            originalFileName: attachment.originalFileName,
            mimeType: attachment.mimeType,
            fileExtension: attachment.fileExtension,
            fileSize: attachment.fileSize,
            contentHash: attachment.contentHash,
            thumbnailHash: attachment.thumbnailHash,
            storageDisk: attachment.storageDisk,
            storagePath: attachment.storagePath,
            previewPath: attachment.previewPath,
            transcodedPath: attachment.transcodedPath,
            uploadStatus: attachment.uploadStatus,
            uploadedAt: attachment.uploadedAt.toISOString(),
        })),
    };

    return {
        attachments,
        manifestJson,
        manifestHash: hashJson(manifestJson),
        ...counts,
    };
}

function buildRecordForPersistence(input) {
    const formHash = hashJson(buildFormPayload(input));
    const faultHash = hashJson(buildFaultPayload(input));
    const partsHash = hashJson(input.parts);
    const measurementsHash = hashJson(input.measurements);
    const replacementsHash = hashJson(input.replacements);

    return {
        ...input,
        hashes: {
            formHash,
            faultHash,
            partsHash,
            measurementsHash,
            replacementsHash,
            attachmentManifestHash: input.manifest.manifestHash,
        },
    };
}

function createSubmitInput(record) {
    return {
        recordId: record.recordId,
        aircraftRegNo: record.aircraftRegNo,
        aircraftType: record.aircraftType,
        jobCardNo: record.jobCardNo,
        revision: record.revision,
        ataCode: record.ataCode,
        workType: record.workType,
        locationCode: record.locationCode || '',
        performerEmployeeNo: record.performerEmployeeNo,
        requiredTechnicianSignatures: record.requiredTechnicianSignatures,
        requiredReviewerSignatures: record.requiredReviewerSignatures,
        isRII: record.isRII,
        occurrenceTime: Math.floor((record.occurrenceTime || new Date()).getTime() / 1000),
        digest: record.hashes,
        attachmentSummary: {
            manifestHash: record.manifest.manifestHash,
            attachmentCount: record.manifest.attachmentCount,
            documentCount: record.manifest.documentCount,
            imageCount: record.manifest.imageCount,
            videoCount: record.manifest.videoCount,
            totalSize: record.manifest.totalSize,
        },
    };
}

async function requireCurrentUser(address) {
    const user = await userStore.findByAddress(address);
    if (!user) {
        throw createError('当前地址未绑定内部账户，请先登录后再操作', 401);
    }
    if (user.status !== 'active') {
        throw createError('当前账户不可用', 403);
    }
    return user;
}

function buildBasePayload(body, currentUser, previousRecord = null) {
    const previousPayload = previousRecord?.payload || {};
    const previousManifest = previousRecord?.manifest?.manifestJson || null;

    const payloadBody = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const aircraftRegNo = normalizeString(body.aircraftRegNo || previousRecord?.aircraftRegNo);
    const aircraftType = normalizeString(body.aircraftType || previousRecord?.aircraftType);
    const jobCardNo = normalizeString(body.jobCardNo || previousRecord?.jobCardNo || generateJobCardNo());
    const ataCode = normalizeString(body.ataCode || previousRecord?.ataCode);
    const workType = normalizeString(body.workType || previousRecord?.workType);

    assertRequiredString(aircraftRegNo, 'aircraftRegNo');
    assertRequiredString(aircraftType, 'aircraftType');
    assertRequiredString(jobCardNo, 'jobCardNo');
    assertRequiredString(ataCode, 'ataCode');
    assertRequiredString(workType, 'workType');

    const systemRawFormJson = {
        aircraftRegNo,
        aircraftType,
        ataCode,
        workType,
        locationCode: normalizeOptionalString(body.locationCode ?? previousRecord?.locationCode),
        occurrenceTime: body.occurrenceTime ?? previousRecord?.occurrenceTime ?? new Date().toISOString(),
        workDescription: normalizeString(payloadBody.workDescription || previousPayload.workDescription),
        referenceDocument: normalizeOptionalString(payloadBody.referenceDocument ?? previousPayload.referenceDocument),
        faultCode: normalizeOptionalString(payloadBody.faultCode ?? previousPayload.faultCode),
        faultDescription: normalizeOptionalString(payloadBody.faultDescription ?? previousPayload.faultDescription),
        requiredTechnicianSignatures: body.requiredTechnicianSignatures ?? previousRecord?.requiredTechnicianSignatures ?? 1,
        requiredReviewerSignatures: body.requiredReviewerSignatures ?? previousRecord?.requiredReviewerSignatures ?? 1,
        isRII: body.isRII != null ? Boolean(body.isRII) : Boolean(previousRecord?.isRII),
    };

    const payload = {
        workDescription: normalizeString(payloadBody.workDescription || previousPayload.workDescription),
        referenceDocument: normalizeOptionalString(payloadBody.referenceDocument ?? previousPayload.referenceDocument),
        faultCode: normalizeOptionalString(payloadBody.faultCode ?? previousPayload.faultCode),
        faultDescription: normalizeOptionalString(payloadBody.faultDescription ?? previousPayload.faultDescription),
        rawFormJson: payloadBody.rawFormJson ?? previousPayload.rawFormJson ?? systemRawFormJson,
        normalizedFormJson: payloadBody.normalizedFormJson ?? previousPayload.normalizedFormJson ?? null,
    };
    assertRequiredString(payload.workDescription, 'payload.workDescription');

    const parts = normalizeParts(body.parts ?? previousRecord?.parts ?? []);
    const measurements = normalizeMeasurements(body.measurements ?? previousRecord?.measurements ?? []);
    const replacements = normalizeReplacements(body.replacements ?? previousRecord?.replacements ?? []);
    const manifest = normalizeManifest(body.manifest || previousManifest, previousRecord?.attachments || []);

    return {
        aircraftRegNo,
        aircraftType,
        jobCardNo,
        ataCode,
        workType,
        locationCode: normalizeOptionalString(body.locationCode ?? previousRecord?.locationCode),
        performerUserId: currentUser.id,
        performerEmployeeNo: normalizeString(previousRecord?.performerEmployeeNo || currentUser.employeeNo),
        performerName: normalizeOptionalString(previousRecord?.performerName ?? currentUser.name),
        requiredTechnicianSignatures: Math.max(1, assertPositiveInteger(body.requiredTechnicianSignatures ?? previousRecord?.requiredTechnicianSignatures, 'requiredTechnicianSignatures', 1)),
        requiredReviewerSignatures: Math.max(1, assertPositiveInteger(body.requiredReviewerSignatures ?? previousRecord?.requiredReviewerSignatures, 'requiredReviewerSignatures', 1)),
        isRII: body.isRII != null ? Boolean(body.isRII) : Boolean(previousRecord?.isRII),
        occurrenceTime: toDateOrNull(body.occurrenceTime ?? previousRecord?.occurrenceTime, 'occurrenceTime') || new Date(),
        payload,
        parts,
        measurements,
        replacements,
        manifest,
        attachments: manifest.attachments,
    };
}

function createPreparedSubmitResponse(record, currentUser) {
    const signedDigest = buildActionDigest(record.recordId, 'submit', record.hashes, currentUser.employeeNo);

    return {
        recordId: record.recordId,
        rootRecordId: record.rootRecordId,
        revision: record.revision,
        jobCardNo: record.jobCardNo,
        performerEmployeeNo: record.performerEmployeeNo,
        performerName: record.performerName,
        signedDigest,
        requestBody: {
            recordId: record.recordId,
            aircraftRegNo: record.aircraftRegNo,
            aircraftType: record.aircraftType,
            jobCardNo: record.jobCardNo,
            ataCode: record.ataCode,
            workType: record.workType,
            locationCode: record.locationCode,
            performerEmployeeNo: record.performerEmployeeNo,
            performerName: record.performerName,
            requiredTechnicianSignatures: record.requiredTechnicianSignatures,
            requiredReviewerSignatures: record.requiredReviewerSignatures,
            isRII: record.isRII,
            occurrenceTime: record.occurrenceTime ? new Date(record.occurrenceTime).toISOString() : null,
            payload: record.payload,
            parts: record.parts,
            measurements: record.measurements,
            replacements: record.replacements,
            manifest: record.manifest.manifestJson,
            specifiedSigners: record.specifiedSigners || [],
        },
        preview: {
            recordId: record.recordId,
            jobCardNo: record.jobCardNo,
            performerEmployeeNo: record.performerEmployeeNo,
            performerName: record.performerName,
            signerEmployeeNo: currentUser.employeeNo,
            hashes: record.hashes,
            manifestSummary: {
                attachmentCount: record.manifest.attachmentCount,
                documentCount: record.manifest.documentCount,
                imageCount: record.manifest.imageCount,
                videoCount: record.manifest.videoCount,
                otherCount: record.manifest.otherCount,
                totalSize: record.manifest.totalSize,
            },
            signedDigest,
        },
    };
}

async function prepareSubmitRecord(currentAddress, body) {
    const currentUser = await requireCurrentUser(currentAddress);
    const basePayload = buildBasePayload(body || {}, currentUser);
    const specifiedSigners = await resolveSpecifiedSigners(body.specifiedSigners, []);
    const recordId = body.recordId ? assertBytes32Hex(body.recordId, 'recordId') : generateRecordId(basePayload.jobCardNo, 1);
    const record = buildRecordForPersistence({
        ...basePayload,
        specifiedSigners,
        recordId,
        rootRecordId: recordId,
        previousRecordId: null,
        revision: 1,
    });

    validateSpecifiedSignerCoverage(record);

    return createPreparedSubmitResponse(record, currentUser);
}

async function submitRecord(currentAddress, body) {
    const currentUser = await requireCurrentUser(currentAddress);
    const basePayload = buildBasePayload(body || {}, currentUser);
    const specifiedSigners = await resolveSpecifiedSigners(body.specifiedSigners, []);
    const recordId = body.recordId ? assertBytes32Hex(body.recordId, 'recordId') : generateRecordId(basePayload.jobCardNo, 1);
    const record = buildRecordForPersistence({
        ...basePayload,
        specifiedSigners,
        recordId,
        rootRecordId: recordId,
        previousRecordId: null,
        revision: 1,
    });

    validateSpecifiedSignerCoverage(record);

    const expectedDigest = buildActionDigest(record.recordId, 'submit', record.hashes, currentUser.employeeNo);
    if (body.signedDigest !== expectedDigest) {
        throw createError('signedDigest 与服务端计算结果不一致', 400);
    }
    ensureSignatureMatchesAddress(body.signedDigest, body.signature, currentUser.address);

    const submitResult = await maintenanceChainService.submitRecord(
        createSubmitInput(record),
        currentUser.employeeNo,
        body.signedDigest,
        body.signature
    );

    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const inserted = await maintenanceStore.insertRecordGraph(
            {
                ...record,
                status: submitResult.chainRecord.status,
                chainRecordId: record.recordId,
                chainTxHash: submitResult.txHash,
                chainBlockNumber: submitResult.blockNumber,
                technicianSignatureCount: submitResult.chainRecord.technicianSignatureCount,
                reviewerSignatureCount: submitResult.chainRecord.reviewerSignatureCount,
                submittedAt: new Date(),
                createdBy: currentUser.id,
            },
            connection
        );

        const signatureId = await maintenanceStore.insertSignature(
            inserted.maintenanceRecordDbId,
            {
                signerRole: 'technician',
                action: 'submit',
                signerUserId: currentUser.id,
                signerEmployeeNo: currentUser.employeeNo,
                signerName: currentUser.name,
                signerAddress: currentUser.address,
                signedDigest: body.signedDigest,
                signatureHash: ethers.keccak256(body.signature),
                signatureAlgorithm: 'EIP-191',
                signaturePayloadPath: normalizeOptionalString(body.signaturePayloadPath),
                chainTxHash: submitResult.txHash,
                signedAt: new Date(),
            },
            connection
        );

        await maintenanceStore.markSpecifiedSignerSigned(
            inserted.maintenanceRecordDbId,
            'technician',
            currentUser.employeeNo,
            signatureId,
            new Date(),
            connection
        );

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    return maintenanceStore.getRecordDetailByRecordId(record.recordId);
}

async function appendSignature(currentAddress, recordId, body) {
    const currentUser = await requireCurrentUser(currentAddress);
    const record = await maintenanceStore.getRecordDetailByRecordId(recordId);
    if (!record) {
        throw createError('检修记录不存在', 404);
    }

    const signerRole = normalizeRole(body.signerRole);
    const action = normalizeAction(body.action);
    if (!SIGN_ACTIONS.has(action)) {
        throw createError('不支持的签名动作', 400);
    }
    assertRequiredString(signerRole, 'signerRole');
    ensureActionMatchesRole(action, signerRole);
    ensureCurrentUserIsSpecifiedSigner(record, signerRole, currentUser);

    const expectedDigest = buildActionDigest(record.recordId, action, record.hashes, currentUser.employeeNo);
    if (body.signedDigest !== expectedDigest) {
        throw createError('signedDigest 与服务端计算结果不一致', 400);
    }
    ensureSignatureMatchesAddress(body.signedDigest, body.signature, currentUser.address);

    const result = await maintenanceChainService.appendSignature(
        record.chainRecordId || record.recordId,
        signerRole,
        action,
        currentUser.employeeNo,
        body.signedDigest,
        body.signature
    );

    const rejectedAt = action === 'reject' ? new Date() : record.rejectedAt;
    const rejectionReason = action === 'reject'
        ? normalizeOptionalString(body.rejectionReason)
        : record.rejectionReason;

    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const signatureId = await maintenanceStore.insertSignature(
            record.id,
            {
                signerRole,
                action,
                signerUserId: currentUser.id,
                signerEmployeeNo: currentUser.employeeNo,
                signerName: currentUser.name,
                signerAddress: currentUser.address,
                signedDigest: body.signedDigest,
                signatureHash: ethers.keccak256(body.signature),
                signatureAlgorithm: 'EIP-191',
                signaturePayloadPath: normalizeOptionalString(body.signaturePayloadPath),
                chainTxHash: result.txHash,
                signedAt: new Date(),
            },
            connection
        );

        await maintenanceStore.markSpecifiedSignerSigned(
            record.id,
            signerRole,
            currentUser.employeeNo,
            signatureId,
            new Date(),
            connection
        );

        await maintenanceStore.updateRecordAfterSignature(
            record.recordId,
            {
                status: result.chainRecord.status,
                technicianSignatureCount: result.chainRecord.technicianSignatureCount,
                reviewerSignatureCount: result.chainRecord.reviewerSignatureCount,
                chainTxHash: result.txHash,
                chainBlockNumber: result.blockNumber,
                rejectionReason,
                rejectedAt,
                releasedAt: result.chainRecord.releasedAt > 0
                    ? new Date(result.chainRecord.releasedAt * 1000)
                    : record.releasedAt,
            },
            connection
        );

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    return maintenanceStore.getRecordDetailByRecordId(record.recordId);
}

async function resubmitRejectedRecord(currentAddress, recordId, body) {
    const currentUser = await requireCurrentUser(currentAddress);
    const previousRecord = await maintenanceStore.getRecordDetailByRecordId(recordId);
    if (!previousRecord) {
        throw createError('原检修记录不存在', 404);
    }
    if (!STATUS_ALLOWED_FOR_RESUBMIT.has(previousRecord.status)) {
        throw createError('只有已驳回的记录才能重提新 revision', 409);
    }
    if (previousRecord.supersededByRecordId) {
        throw createError('该记录已经发起过 revision 重提', 409);
    }

    const basePayload = buildBasePayload(body || {}, currentUser, previousRecord);
    const specifiedSigners = await resolveSpecifiedSigners(body.specifiedSigners, previousRecord.specifiedSigners || []);
    const nextRevision = previousRecord.revision + 1;
    const nextRecordId = body.nextRecordId || body.recordId
        ? assertBytes32Hex(body.nextRecordId || body.recordId, 'nextRecordId')
        : generateRecordId(basePayload.jobCardNo, nextRevision);
    const record = buildRecordForPersistence({
        ...basePayload,
        specifiedSigners,
        recordId: nextRecordId,
        rootRecordId: previousRecord.rootRecordId,
        previousRecordId: previousRecord.recordId,
        revision: nextRevision,
    });

    validateSpecifiedSignerCoverage(record);

    const expectedDigest = buildActionDigest(record.recordId, 'submit', record.hashes, currentUser.employeeNo);
    if (body.signedDigest !== expectedDigest) {
        throw createError('signedDigest 与服务端计算结果不一致', 400);
    }
    ensureSignatureMatchesAddress(body.signedDigest, body.signature, currentUser.address);

    const submitResult = await maintenanceChainService.submitRecord(
        createSubmitInput(record),
        currentUser.employeeNo,
        body.signedDigest,
        body.signature
    );

    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const inserted = await maintenanceStore.insertRecordGraph(
            {
                ...record,
                status: submitResult.chainRecord.status,
                chainRecordId: record.recordId,
                chainTxHash: submitResult.txHash,
                chainBlockNumber: submitResult.blockNumber,
                technicianSignatureCount: submitResult.chainRecord.technicianSignatureCount,
                reviewerSignatureCount: submitResult.chainRecord.reviewerSignatureCount,
                submittedAt: new Date(),
                createdBy: currentUser.id,
            },
            connection
        );

        const signatureId = await maintenanceStore.insertSignature(
            inserted.maintenanceRecordDbId,
            {
                signerRole: 'technician',
                action: 'submit',
                signerUserId: currentUser.id,
                signerEmployeeNo: currentUser.employeeNo,
                signerName: currentUser.name,
                signerAddress: currentUser.address,
                signedDigest: body.signedDigest,
                signatureHash: ethers.keccak256(body.signature),
                signatureAlgorithm: 'EIP-191',
                signaturePayloadPath: normalizeOptionalString(body.signaturePayloadPath),
                chainTxHash: submitResult.txHash,
                signedAt: new Date(),
            },
            connection
        );

        await maintenanceStore.markSpecifiedSignerSigned(
            inserted.maintenanceRecordDbId,
            'technician',
            currentUser.employeeNo,
            signatureId,
            new Date(),
            connection
        );

        await maintenanceStore.markRecordAsResubmitted(previousRecord.recordId, record.recordId, connection);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    return {
        sourceRecordId: previousRecord.recordId,
        newRecord: await maintenanceStore.getRecordDetailByRecordId(record.recordId),
    };
}

async function getRecord(recordId) {
    const record = await maintenanceStore.getRecordDetailByRecordId(recordId);
    if (!record) {
        throw createError('检修记录不存在', 404);
    }
    return record;
}

async function listRevisions(recordId) {
    const record = await maintenanceStore.getRecordDetailByRecordId(recordId);
    if (!record) {
        throw createError('检修记录不存在', 404);
    }
    return maintenanceStore.listRevisionsByRootRecordId(record.rootRecordId);
}

function normalizeStatuses(input) {
    if (!input) {
        return [];
    }

    if (Array.isArray(input)) {
        return input.map((item) => normalizeString(item)).filter(Boolean);
    }

    return String(input)
        .split(',')
        .map((item) => normalizeString(item))
        .filter(Boolean);
}

async function listRecords(currentAddress, query = {}) {
    const currentUser = await requireCurrentUser(currentAddress);
    assertUserHasAnyPermission(currentUser, ['record.view', 'record.approve'], '当前用户无权查看检修记录');

    return maintenanceStore.listRecordSummaries({
        page: query.page,
        pageSize: query.pageSize,
        status: query.status,
        statuses: normalizeStatuses(query.statuses),
        keyword: query.keyword,
        aircraftRegNo: query.aircraftRegNo,
        performerEmployeeNo: query.performerEmployeeNo,
        ataCode: query.ataCode,
    });
}

async function getWorkbench(currentAddress) {
    const currentUser = await requireCurrentUser(currentAddress);
    assertUserHasAnyPermission(currentUser, ['record.approve'], '当前用户无权查看审批工作台');

    const [allRecords, reviewQueue, releaseQueue, rejectedQueue, recentActivity] = await Promise.all([
        maintenanceStore.listRecordSummaries({ page: 1, pageSize: 1 }),
        maintenanceStore.listRecordSummaries({ page: 1, pageSize: 6, statuses: ['submitted'] }),
        maintenanceStore.listRecordSummaries({ page: 1, pageSize: 6, statuses: ['peer_checked', 'rii_approved'] }),
        maintenanceStore.listRecordSummaries({ page: 1, pageSize: 6, statuses: ['rejected'] }),
        maintenanceStore.listRecordSummaries({ page: 1, pageSize: 8 }),
    ]);

    const releasedCount = (await maintenanceStore.listRecordSummaries({
        page: 1,
        pageSize: 1,
        statuses: ['released'],
    })).total;

    return {
        summary: {
            totalRecords: allRecords.total,
            pendingReviewCount: reviewQueue.total,
            pendingReleaseCount: releaseQueue.total,
            rejectedCount: rejectedQueue.total,
            releasedCount,
        },
        queues: {
            review: reviewQueue.rows,
            release: releaseQueue.rows,
            rejected: rejectedQueue.rows,
            recent: recentActivity.rows,
        },
    };
}

module.exports = {
    __internal: {
        buildActionDigest,
        buildBasePayload,
        buildRecordForPersistence,
        createPreparedSubmitResponse,
        generateJobCardNo,
        generateRecordId,
    },
    appendSignature,
    getRecord,
    getWorkbench,
    listRevisions,
    listRecords,
    prepareSubmitRecord,
    resubmitRejectedRecord,
    submitRecord,
};