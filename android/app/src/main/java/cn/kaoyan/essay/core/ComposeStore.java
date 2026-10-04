package cn.kaoyan.essay.core;

import cn.kaoyan.essay.net.Dto;

/**
 * 写作链路的会话内状态：题目、识图结果与最近一次成文。
 * 结果页、答题卡页都从这里取数据，避免把大数据塞进 Bundle。
 */
public final class ComposeStore {

    private ComposeStore() {
    }

    /** 当前题干（生成与结果页重新生成共用）。 */
    public static String question = "";
    /** 最近一次识图结果；原样回传给 /api/compose，服务端认得 vision.raw。 */
    public static Dto.ImageAnalysis analysis;
    /** 已识图但尚未生成的题图 data URL（识别失败时的补救通道）。 */
    public static String pendingImage;
    /** 从题库带入的真题 id（成文时服务端据此引用真题题干与图表数据）。 */
    public static String examId;
    /** 最近一次成文结果。 */
    public static Dto.Compose last;
    public static long lastAt;
    /** 最近一次生成耗时（毫秒），结果页概览里显示。 */
    public static long lastMs;
    /** 结果页「重新生成」：回到写作页后立刻再跑一次。 */
    public static boolean autoGenerate;

    public static boolean hasResult() {
        return last != null;
    }
}
