package cn.kaoyan.essay.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;

import java.util.ArrayList;
import java.util.List;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.databinding.FragmentStudyAssemblyBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;

/**
 * 模块组装子页：按轨道展开讲义模块，模块下逐句看模板句（点句子复制英文）。
 * 视图按需展开，避免一次铺几百条模板句。
 */
public class StudyAssemblyFragment extends Fragment {

    private FragmentStudyAssemblyBinding b;
    private ApiClient.Request trackReq;
    private final List<Dto.KbTrack> tracks = new ArrayList<>();
    private Dto.KbTrack current;
    private boolean suppress;

    public StudyAssemblyFragment() {
        super(R.layout.fragment_study_assembly);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentStudyAssemblyBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        loadTracks();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (trackReq != null) trackReq.cancel();
        b = null;
    }

    private void loadTracks() {
        if (trackReq != null) trackReq.cancel();
        trackReq = EeaApi.kbModules(null, new ApiClient.Callback<Dto.KbTrackPage>() {
            @Override
            public void onSuccess(Dto.KbTrackPage data) {
                if (b == null) return;
                tracks.clear();
                tracks.addAll(data.tracks);
                List<String> labels = new ArrayList<>();
                for (Dto.KbTrack track : tracks) labels.add(track.label);
                suppress = true;
                b.smTrack.setSimpleItems(labels.toArray(new String[0]));
                b.smTrack.setText(labels.isEmpty() ? "" : labels.get(0), false);
                suppress = false;
                b.smTrack.setOnItemClickListener((parent, v, position, id) -> loadTrack(tracks.get(position).id));
                if (!tracks.isEmpty()) loadTrack(tracks.get(0).id);
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.smDesc.setText(getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private void loadTrack(String trackId) {
        if (suppress) return;
        if (trackReq != null) trackReq.cancel();
        b.smBody.removeAllViews();
        b.smCount.setText(R.string.sm_loading);
        trackReq = EeaApi.kbModules(trackId, new ApiClient.Callback<Dto.KbTrackPage>() {
            @Override
            public void onSuccess(Dto.KbTrackPage data) {
                if (b == null) return;
                current = data.track;
                render();
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.smCount.setText(getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private void render() {
        if (current == null) {
            b.smCount.setText(R.string.sm_empty);
            return;
        }
        b.smDesc.setText(current.description);
        b.smCount.setText(getString(R.string.sm_count, current.count));
        b.smBody.removeAllViews();
        if (current.modules.isEmpty()) {
            addLine(b.smBody, getString(R.string.sm_empty), R.color.text_secondary);
            return;
        }
        for (Dto.KbModule module : current.modules) addModule(module);
    }

    /** 模块 = 可点标题（展开/收起）+ 懒加载的模板句区。 */
    private void addModule(final Dto.KbModule module) {
        final LinearLayout column = new LinearLayout(requireContext());
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(0, dp(8), 0, dp(4));

        final TextView header = new TextView(requireContext());
        header.setText(module.label + "（" + module.count + "）");
        header.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_body));
        header.setTextColor(ContextCompat.getColor(requireContext(), R.color.brand_blue));
        header.setPadding(0, dp(6), 0, dp(6));
        column.addView(header);

        final LinearLayout body = new LinearLayout(requireContext());
        body.setOrientation(LinearLayout.VERTICAL);
        body.setVisibility(View.GONE);
        column.addView(body);
        header.setOnClickListener(v -> {
            boolean show = body.getVisibility() != View.VISIBLE;
            body.setVisibility(show ? View.VISIBLE : View.GONE);
            if (show && body.getChildCount() == 0) fillTemplates(body, module);
        });

        b.smBody.addView(column);
    }

    private void fillTemplates(LinearLayout body, Dto.KbModule module) {
        if (module.templates.isEmpty()) {
            addLine(body, getString(R.string.sm_empty), R.color.text_secondary);
            return;
        }
        for (Dto.KbTemplate template : module.templates) {
            final TextView line = new TextView(requireContext());
            line.setText(template.en);
            line.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_body));
            line.setTextColor(ContextCompat.getColor(requireContext(), R.color.text_primary));
            line.setPadding(dp(8), dp(4), dp(8), dp(4));
            line.setOnClickListener(v -> copy(template.en));
            body.addView(line);
            if (template.zh != null && !template.zh.isEmpty()) {
                addLine(body, template.zh, R.color.text_secondary);
            }
        }
    }

    private void copy(String text) {
        Context ctx = getContext();
        if (ctx == null || text == null || text.isEmpty()) return;
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("template", text));
        Ui.toast(this, R.string.sm_copied);
    }

    private void addLine(LinearLayout parent, String text, int colorRes) {
        if (text == null || text.isEmpty()) return;
        TextView tv = new TextView(parent.getContext());
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_label));
        tv.setTextColor(ContextCompat.getColor(parent.getContext(), colorRes));
        tv.setPadding(dp(8), 0, 0, dp(4));
        parent.addView(tv);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
