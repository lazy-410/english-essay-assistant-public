package cn.kaoyan.essay.ui;

/** 需要自己先处理返回键的页面（如内嵌网页岛屿的页内后退）。 */
public interface BackAware {

    /** 返回 true 表示已消费本次返回。 */
    boolean onBackPressed();
}
