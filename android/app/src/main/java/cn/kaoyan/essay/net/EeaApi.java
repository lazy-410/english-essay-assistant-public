package cn.kaoyan.essay.net;

import org.json.JSONObject;

/**
 * 接口门面：把每个端点包成一个带类型的静态方法，界面层不直接拼 URL。
 * 新增端点在 B2/B3/B4 里继续往这里加。
 */
public final class EeaApi {

    private EeaApi() {
    }

    private static ApiClient api() {
        return ApiClient.get();
    }

    // ---------- 服务与授权 ----------

    public static ApiClient.Request health(ApiClient.Callback<Dto.Health> cb) {
        return api().get("/api/health", Dto.Health::parse, cb);
    }

    public static ApiClient.Request licenseStatus(ApiClient.Callback<Dto.License> cb) {
        return api().get("/api/license-status", Dto.License::parse, cb);
    }

    public static ApiClient.Request activate(String code, ApiClient.Callback<Dto.Activated> cb) {
        JSONObject body = new JSONObject();
        put(body, "code", code);
        return api().post("/api/activate", body, ApiClient.TIMEOUT_NORMAL, Dto.Activated::parse, cb);
    }

    // ---------- 配置 ----------

    public static ApiClient.Request config(ApiClient.Callback<Dto.Config> cb) {
        return api().get("/api/config", Dto.Config::parse, cb);
    }

    public static ApiClient.Request saveConfig(JSONObject patch, ApiClient.Callback<Dto.Config> cb) {
        return api().post("/api/config", patch, ApiClient.TIMEOUT_QUICK, Dto.Config::parse, cb);
    }

    public static ApiClient.Request examType(ApiClient.Callback<Dto.ExamType> cb) {
        return api().get("/api/study/exam-type", Dto.ExamType::parse, cb);
    }

    public static ApiClient.Request setExamType(String examType, ApiClient.Callback<Dto.ExamType> cb) {
        JSONObject body = new JSONObject();
        put(body, "examType", examType);
        return api().post("/api/study/exam-type", body, ApiClient.TIMEOUT_NORMAL, Dto.ExamType::parse, cb);
    }

    // ---------- 连通性测试 ----------

    public static ApiClient.Request testDeepseek(ApiClient.Callback<Dto.TestResult> cb) {
        return api().post("/api/deepseek/test", new JSONObject(), ApiClient.TIMEOUT_NORMAL, data -> {
            Dto.TestResult r = new Dto.TestResult();
            r.model = data.optString("model", "");
            r.latencyMs = data.optLong("latencyMs", 0);
            r.note = data.optString("reply", "");
            return r;
        }, cb);
    }

    public static ApiClient.Request testVision(ApiClient.Callback<Dto.TestResult> cb) {
        return api().post("/api/vision/test", new JSONObject(), ApiClient.TIMEOUT_NORMAL, data -> {
            Dto.TestResult r = new Dto.TestResult();
            r.model = data.optString("model", "");
            r.latencyMs = data.optLong("latencyMs", 0);
            String category = data.optString("category", "");
            r.note = category.isEmpty() ? "" : "识别分类：" + category;
            return r;
        }, cb);
    }

    // ---------- 统计（关于页） ----------

    public static ApiClient.Request writingStats(ApiClient.Callback<Dto.WritingStats> cb) {
        return api().get("/api/writing/stats", Dto.WritingStats::parse, cb);
    }

    public static ApiClient.Request kbStats(ApiClient.Callback<Dto.KbStats> cb) {
        return api().get("/api/kb/stats", Dto.KbStats::parse, cb);
    }

    // ---------- 识图与清洗 ----------

    /** 图片识别（视觉 + 本地 OCR 兜底），返回题干与冲突提示。 */
    public static ApiClient.Request analyzeImage(String dataUrl, ApiClient.Callback<Dto.ImageAnalysis> cb) {
        JSONObject body = new JSONObject();
        put(body, "image", dataUrl);
        return api().post("/api/image/analyze", body, ApiClient.TIMEOUT_GENERATE, Dto.ImageAnalysis::parse, cb);
    }

    /** 题目清洗（OCR 结果纠错还原），贴文本进题干时用。 */
    public static ApiClient.Request cleanQuestion(String text, ApiClient.Callback<Dto.Cleaned> cb) {
        JSONObject body = new JSONObject();
        put(body, "text", text);
        return api().post("/api/question/clean", body, ApiClient.TIMEOUT_NORMAL, Dto.Cleaned::parse, cb);
    }

    // ---------- 成文 ----------

    /** 流式成文：事件逐个回调，界面据此显示真实进度。 */
    public static ApiClient.Request composeStream(JSONObject body, ApiClient.StreamCallback cb) {
        return api().stream("/api/compose/stream", body, cb);
    }

    /** 结果页行文复盘。 */
    public static ApiClient.Request analysisEssay(JSONObject body, ApiClient.Callback<Dto.Raw> cb) {
        return api().post("/api/analysis/essay", body, ApiClient.TIMEOUT_GENERATE, Dto.Raw::parse, cb);
    }

    // ---------- 题库 ----------

    /** 题库列表；query 直接给 'examType=e1&year=2020' 形式（服务端只认字符串）。 */
    public static ApiClient.Request exams(String query, ApiClient.Callback<Dto.ExamPage> cb) {
        String path = query == null || query.isEmpty() ? "/api/exams" : "/api/exams?" + query;
        return api().get(path, Dto.ExamPage::parse, cb);
    }

    public static ApiClient.Request examDetail(String id, ApiClient.Callback<Dto.ExamDetail> cb) {
        return api().get("/api/exams/detail?id=" + encode(id), Dto.ExamDetail::parse, cb);
    }

    public static ApiClient.Request examStats(ApiClient.Callback<Dto.ExamStats> cb) {
        return api().get("/api/exams/stats", Dto.ExamStats::parse, cb);
    }

    /** 真题图片（exam-assets/… 或 pages/…）：二进制 GET。 */
    public static ApiClient.Request examImage(String path, ApiClient.Callback<byte[]> cb) {
        String rel = path == null ? "" : path;
        if (!rel.startsWith("/")) rel = "/" + rel;
        return api().getBytes(rel, ApiClient.TIMEOUT_NORMAL, cb);
    }

    // ---------- 答题卡 ----------

    public static ApiClient.Request handTemplates(ApiClient.Callback<Dto.HandTemplates> cb) {
        return api().get("/api/handwrite/templates", Dto.HandTemplates::parse, cb);
    }

    public static ApiClient.Request handFonts(ApiClient.Callback<Dto.HandFonts> cb) {
        return api().get("/api/handwrite/fonts", Dto.HandFonts::parse, cb);
    }

    public static ApiClient.Request handwrite(JSONObject payload, ApiClient.Callback<Dto.Handwrite> cb) {
        return api().post("/api/handwrite", payload, ApiClient.TIMEOUT_NORMAL, Dto.Handwrite::parse, cb);
    }

    /** 答题卡 PDF：二进制响应，直接拿 bytes 落盘分享。 */
    public static ApiClient.Request handwritePdf(JSONObject payload, ApiClient.Callback<byte[]> cb) {
        return api().bytes("/api/handwrite/pdf", payload, ApiClient.TIMEOUT_NORMAL, cb);
    }

    // ---------- 作文批改 ----------

    /** 第一步：识别手写作文照片（视觉优先，本地 OCR 兜底）。 */
    public static ApiClient.Request reviewOcr(String dataUrl, ApiClient.Callback<Dto.ReviewOcr> cb) {
        JSONObject body = new JSONObject();
        put(body, "image", dataUrl);
        return api().post("/api/review/ocr", body, ApiClient.TIMEOUT_GENERATE, Dto.ReviewOcr::parse, cb);
    }

    /** 第二步：题型自动判定（用户可改选）。 */
    public static ApiClient.Request reviewClassify(String essayText, String questionText, ApiClient.Callback<Dto.Detection> cb) {
        JSONObject body = new JSONObject();
        put(body, "essayText", essayText);
        put(body, "questionText", questionText);
        return api().post("/api/review/classify", body, ApiClient.TIMEOUT_NORMAL, Dto.Detection::parse, cb);
    }

    /** 第三步：用户确认文本后才批改。examId 会带入官方题干、图表数据与范文。 */
    public static ApiClient.Request reviewAnalyze(JSONObject body, ApiClient.Callback<Dto.Review> cb) {
        return api().post("/api/review/analyze", body, ApiClient.TIMEOUT_GENERATE, Dto.Review::parse, cb);
    }

    /** 按采纳的修改项生成终稿（issues 原样回传批改结果里的数组）。 */
    public static ApiClient.Request reviewApply(String essayText, org.json.JSONArray issues, java.util.List<String> acceptedIds, ApiClient.Callback<Dto.ReviewApply> cb) {
        JSONObject body = new JSONObject();
        try {
            put(body, "essayText", essayText);
            body.put("issues", issues == null ? new org.json.JSONArray() : issues);
            org.json.JSONArray ids = new org.json.JSONArray();
            for (String id : acceptedIds) {
                if (id != null && !id.isEmpty()) ids.put(id);
            }
            body.put("acceptedIds", ids);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        return api().post("/api/review/apply", body, ApiClient.TIMEOUT_NORMAL, Dto.ReviewApply::parse, cb);
    }

    /** 真题行文精讲 PDF（/api/print/analysis）。 */
    public static ApiClient.Request printAnalysis(String examId, boolean ai, ApiClient.Callback<byte[]> cb) {
        JSONObject body = new JSONObject();
        try {
            put(body, "examId", examId);
            body.put("ai", ai);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        return api().bytes("/api/print/analysis", body, ApiClient.TIMEOUT_GENERATE, cb);
    }

    /** 批改报告 PDF：二进制响应，直接落盘分享。 */    public static ApiClient.Request printReview(JSONObject reviewRaw, String finalText, ApiClient.Callback<byte[]> cb) {
        JSONObject body = new JSONObject();
        try {
            if (reviewRaw != null) body.put("review", reviewRaw);
            put(body, "finalText", finalText);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        return api().bytes("/api/print/review", body, ApiClient.TIMEOUT_GENERATE, cb);
    }

    // ---------- 学习卡片（模板句掌握） ----------

    /** 学习计划与今日单元（/api/study/plan）。 */
    public static ApiClient.Request studyPlan(ApiClient.Callback<Dto.StudyPlan> cb) {
        return api().get("/api/study/plan", Dto.StudyPlan::parse, cb);
    }

    /** 保存计划选项（轨道 / 每日数量 / 含选修 / 含拓展）。 */
    public static ApiClient.Request saveStudyPlan(JSONObject options, ApiClient.Callback<Dto.StudyPlan> cb) {
        return api().post("/api/study/plan", options == null ? new JSONObject() : options,
                ApiClient.TIMEOUT_NORMAL, Dto.StudyPlan::parse, cb);
    }

    /** 切换当前单元。 */
    public static ApiClient.Request setStudyUnit(int unitIndex, ApiClient.Callback<Dto.Raw> cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("currentUnit", unitIndex);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        return api().post("/api/study/unit", body, ApiClient.TIMEOUT_NORMAL, Dto.Raw::parse, cb);
    }

    /** 讲义词表检索（/api/kb/vocab）。 */
    public static ApiClient.Request kbVocab(String keyword, int limit, ApiClient.Callback<Dto.VocabPage> cb) {
        StringBuilder path = new StringBuilder("/api/kb/vocab?limit=").append(limit);
        if (keyword != null && !keyword.trim().isEmpty()) {
            path.append("&keyword=").append(encode(keyword.trim()));
        }
        return api().get(path.toString(), Dto.VocabPage::parse, cb);
    }

    /** 写作轨道与模块（/api/kb/modules?track=…）：指定轨道时返回该轨道的模块与模板句。 */
    public static ApiClient.Request kbModules(String track, ApiClient.Callback<Dto.KbTrackPage> cb) {
        String path = track == null || track.isEmpty() ? "/api/kb/modules" : "/api/kb/modules?track=" + encode(track);
        return api().get(path, Dto.KbTrackPage::parse, cb);
    }

    /** 真题行文解析（/api/analysis/exam）。 */
    public static ApiClient.Request analysisExam(String examId, boolean ai, ApiClient.Callback<Dto.Raw> cb) {
        String path = "/api/analysis/exam?id=" + encode(examId) + (ai ? "&ai=1" : "");
        return api().get(path, Dto.Raw::parse, cb);
    }

    /** 背诵卡片 PDF（/api/print/cards）：按当前筛选导出。 */
    public static ApiClient.Request printCards(JSONObject filter, ApiClient.Callback<byte[]> cb) {
        return api().bytes("/api/print/cards", filter == null ? new JSONObject() : filter,
                ApiClient.TIMEOUT_GENERATE, cb);
    }
    public static ApiClient.Request setCardStatus(String cardId, String status, ApiClient.Callback<Dto.StudyProgress> cb) {
        JSONObject body = new JSONObject();
        put(body, "cardId", cardId);
        put(body, "status", status);
        return api().post("/api/study/progress", body, ApiClient.TIMEOUT_NORMAL, Dto.StudyProgress::parse, cb);
    }

    /** 成文后按 skeletonId 找回对应的学习卡片（只做匹配，不改状态）。 */
    public static ApiClient.Request linkEssay(java.util.List<String> skeletonIds, ApiClient.Callback<Dto.StudyLink> cb) {
        JSONObject body = new JSONObject();
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (String id : skeletonIds) {
                if (id != null && !id.isEmpty()) arr.put(id);
            }
            body.put("skeletonIds", arr);
        } catch (Exception ignored) {
            // JSONArray.put 不会抛
        }
        return api().post("/api/study/link-essay", body, ApiClient.TIMEOUT_NORMAL, Dto.StudyLink::parse, cb);
    }

    /** 批量标记卡片状态（结果页「标记本次模板句已掌握」走 entries 形态）。 */
    public static ApiClient.Request markCards(java.util.List<String> cardIds, String status, ApiClient.Callback<Dto.StudyProgress> cb) {
        JSONObject body = new JSONObject();
        try {
            org.json.JSONArray entries = new org.json.JSONArray();
            for (String id : cardIds) {
                if (id == null || id.isEmpty()) continue;
                JSONObject entry = new JSONObject();
                entry.put("cardId", id);
                entry.put("status", status);
                entries.put(entry);
            }
            body.put("entries", entries);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        return api().post("/api/study/progress", body, ApiClient.TIMEOUT_NORMAL, Dto.StudyProgress::parse, cb);
    }

    /** 流式 done 事件体 → 成文结果（解析入口集中留在 net 包内）。 */
    public static Dto.Compose composeFromEvent(JSONObject data) {
        return Dto.Compose.parse(data);
    }

    private static String encode(String value) {
        if (value == null) return "";
        try {
            return java.net.URLEncoder.encode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    static void put(JSONObject o, String key, String value) {
        try {
            o.put(key, value);
        } catch (Exception ignored) {
            // JSONObject.put(String,String) 不会抛
        }
    }
}
