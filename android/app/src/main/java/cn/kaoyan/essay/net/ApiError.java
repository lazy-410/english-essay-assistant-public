package cn.kaoyan.essay.net;

/**
 * 本地服务调用失败：HTTP 状态、服务端错误码（如 NOT_ACTIVATED）与可展示的中文信息。
 * status == 0 表示连接层失败（服务未起 / 超时 / 解析异常）。
 */
public final class ApiError extends Exception {

    public final int status;
    public final String code;

    public ApiError(int status, String code, String message) {
        super(message == null ? "请求失败" : message);
        this.status = status;
        this.code = code;
    }

    /** 未激活（服务端闸门 403 NOT_ACTIVATED）：界面据此回到激活页。 */
    public boolean isNotActivated() {
        return status == 403 || "NOT_ACTIVATED".equals(code);
    }

    /** 本地服务还没起来（连接失败）：启动页/重试逻辑据此判断。 */
    public boolean isOffline() {
        return status == 0;
    }
}
