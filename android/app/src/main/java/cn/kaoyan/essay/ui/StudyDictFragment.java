package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.databinding.FragmentStudyDictBinding;
import cn.kaoyan.essay.databinding.ItemVocabBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;

/**
 * 模板字典子页：讲义词表检索（中英文关键词），条目可长按复制英文表达。
 */
public class StudyDictFragment extends Fragment {

    private static final int LIMIT = 200;

    private FragmentStudyDictBinding b;
    private ApiClient.Request req;
    private Adapter adapter;
    private final List<Dto.VocabItem> items = new ArrayList<>();

    public StudyDictFragment() {
        super(R.layout.fragment_study_dict);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentStudyDictBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        adapter = new Adapter();
        b.sdList.setLayoutManager(new LinearLayoutManager(requireContext()));
        b.sdList.setAdapter(adapter);
        b.sdSearch.setOnClickListener(v -> search());
        b.sdKeyword.setOnEditorActionListener((v, actionId, event) -> {
            search();
            return true;
        });
        search();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (req != null) req.cancel();
        b = null;
    }

    private void search() {
        if (b == null) return;
        String keyword = b.sdKeyword.getText() == null ? "" : b.sdKeyword.getText().toString();
        if (req != null) req.cancel();
        req = EeaApi.kbVocab(keyword, LIMIT, new ApiClient.Callback<Dto.VocabPage>() {
            @Override
            public void onSuccess(Dto.VocabPage data) {
                if (b == null) return;
                items.clear();
                items.addAll(data.items);
                adapter.notifyDataSetChanged();
                b.sdCount.setText(items.isEmpty()
                        ? getString(R.string.sd_empty)
                        : getString(R.string.sd_count, items.size()));
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.sdCount.setText(getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private final class Adapter extends RecyclerView.Adapter<Adapter.Holder> {

        final class Holder extends RecyclerView.ViewHolder {
            final ItemVocabBinding row;

            Holder(ItemVocabBinding row) {
                super(row.getRoot());
                this.row = row;
            }
        }

        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(ItemVocabBinding.inflate(getLayoutInflater(), parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            final Dto.VocabItem item = items.get(position);
            holder.row.vocabEn.setText(item.en);
            holder.row.vocabZh.setText(item.zh);
            holder.row.vocabPage.setText(item.page > 0 ? getString(R.string.rr_page, item.page) : "");
            holder.row.vocabPage.setVisibility(item.page > 0 ? View.VISIBLE : View.GONE);
            holder.row.getRoot().setOnClickListener(v -> {
                android.content.ClipboardManager cm = (android.content.ClipboardManager)
                        requireContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                if (cm == null) return;
                cm.setPrimaryClip(android.content.ClipData.newPlainText(item.en, item.en));
                Ui.toast(StudyDictFragment.this, R.string.sd_copied);
            });
        }

        @Override
        public int getItemCount() {
            return items.size();
        }
    }
}
