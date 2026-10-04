package cn.kaoyan.essay.core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

import cn.kaoyan.essay.net.Dto;

/**
 * 批改链路的会话内状态：上传的作文照片、OCR 结果、校对文本与批改结论。
 * 三步流程跨页/跨页签共用，避免把大对象塞进 Bundle。
 */
public final class ReviewStore {

    private ReviewStore() {
    }

    /** 上传的作文照片（data URL）。 */
    public static String image;
    /** 识别结果里用户确认前的原始文本（用于「恢复原文」）。 */
    public static String rawText = "";
    /** 校对框里的当前文本。 */
    public static String essayText = "";
    /** 自由模式：题型与题干；真题模式：examId。 */
    public static String category = "";
    public static String questionText = "";
    public static String examId;
    public static String examLabel;
    /** 识别提示（质量低、已旋转等），在校对页顶部如实展示。 */
    public static String ocrNote = "";
    public static boolean ocrLowQuality;
    /** 批改结果与采纳集合。 */
    public static Dto.Review review;
    public static Dto.ReviewApply applied;
    public static final Set<String> accepted = new LinkedHashSet<>();
    /** 显式忽略过的修改项（用于回显状态，不参与终稿）。 */
    public static final Set<String> ignored = new LinkedHashSet<>();
    public static String finalText = "";
    public static boolean aiDeepen = true;
    public static boolean aiGrammar = true;

    public static boolean isExamMode() {
        return examId != null && !examId.isEmpty();
    }

    public static boolean hasReview() {
        return review != null;
    }

    /** 当前终稿：采纳过修改项用终稿，否则用校对文本。 */
    public static String body() {
        String text = finalText != null && !finalText.trim().isEmpty() ? finalText : essayText;
        return text == null ? "" : text.trim();
    }

    /** 批改结果里的 issues 原样数组（/api/review/apply 要求回传原结构）。 */
    public static JSONArray issuesArray() {
        if (review != null && review.raw != null) {
            JSONArray arr = review.raw.optJSONArray("issues");
            if (arr != null) return arr;
        }
        return new JSONArray();
    }

    /** 重新开始一轮批改时清掉结论，保留输入。 */
    public static void resetResult() {
        review = null;
        applied = null;
        accepted.clear();
        ignored.clear();
        finalText = "";
    }

    public static void reset() {
        image = null;
        rawText = "";
        essayText = "";
        category = "";
        questionText = "";
        examId = null;
        examLabel = null;
        ocrNote = "";
        ocrLowQuality = false;
        resetResult();
    }

    /** 走真题模式前的准备：题干与题型由题库决定。 */
    public static void useExam(Dto.ExamBrief exam) {
        examId = exam == null ? null : exam.id;
        examLabel = exam == null ? null : exam.listTitle();
        if (exam != null) {
            questionText = exam.prompt != null && !exam.prompt.isEmpty() ? exam.prompt : exam.directions;
        }
    }

    public static void useFree(String categoryValue, String question) {
        examId = null;
        examLabel = null;
        category = categoryValue == null ? "" : categoryValue;
        questionText = question == null ? "" : question;
    }

    /** 批改入参：真题模式只传 examId，题型与题干交给题库。 */
    public static JSONObject analyzeBody() {
        JSONObject body = new JSONObject();
        try {
            body.put("essayText", essayText);
            body.put("ai", aiDeepen);
            body.put("aiGrammar", aiGrammar);
            if (isExamMode()) {
                body.put("examId", examId);
                if (questionText != null && !questionText.isEmpty()) body.put("questionText", questionText);
            } else {
                body.put("category", category);
                body.put("questionText", questionText == null ? "" : questionText);
            }
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        return body;
    }
}
