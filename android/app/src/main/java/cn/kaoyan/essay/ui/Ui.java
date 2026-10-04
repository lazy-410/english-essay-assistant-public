package cn.kaoyan.essay.ui;

import android.content.Context;
import android.view.View;

import androidx.annotation.StringRes;
import androidx.fragment.app.Fragment;

/** 界面层小工具：Fragment 可能已经 detach，统一在这里判活，避免 each caller 重复写。 */
public final class Ui {

    private Ui() {
    }

    public static void toast(Fragment fragment, String message) {
        if (fragment == null || !fragment.isAdded()) return;
        Context ctx = fragment.getContext();
        if (ctx == null) return;
        android.widget.Toast.makeText(ctx, message, android.widget.Toast.LENGTH_LONG).show();
    }

    public static void toast(Fragment fragment, @StringRes int resId) {
        if (fragment == null || !fragment.isAdded()) return;
        toast(fragment, fragment.getString(resId));
    }

    public static void show(View view, boolean visible) {
        if (view != null) view.setVisibility(visible ? View.VISIBLE : View.GONE);
    }
}
