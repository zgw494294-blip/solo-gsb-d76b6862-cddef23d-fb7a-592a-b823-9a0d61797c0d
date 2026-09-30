import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def import_text(text):
    return client.post("/api/import", json={"text": text})


GOOD = "\n".join(
    [
        "1|甲方在七日内交付设备",
        "2|乙方按 [[1]] 验收后付款",
        "3|争议解决见 [[4]]，违约参照 [[2]]",
        "4|争议提交仲裁",
    ]
)


def test_import_ok_binds_stable_ids():
    r = import_text(GOOD)
    assert r.status_code == 200, r.text
    clauses = r.json()["clauses"]
    assert [c["id"] for c in clauses] == ["c1", "c2", "c3", "c4"]
    assert clauses[1]["body"] == "乙方按 [[c1]] 验收后付款"
    assert clauses[2]["body"] == "争议解决见 [[c4]]，违约参照 [[c2]]"


@pytest.mark.parametrize(
    "text",
    [
        "1|只有一行",  # 少于 2 行
        "1-无分隔符\n2|正常条款",
        "a|编号非数字\n2|正文",
        "0|编号须从 1 开始\n2|正文",
        "01|编号含前导零\n2|正文",
        "1|正文为空编号重复\n1|另一条",
        "1|第一条\n3|缺编号2",
        "1|引用越界 [[9]]\n2|正常",
        "1|标记带空格 [[ 2 ]]\n2|正常",
        "1|未闭合 [[2\n2|正常",
        "1|多余右括号 [[2]]]\n2|正常",
        "1|前导零 [[01]]\n2|正常",
        "1|引用零号 [[0]]\n2|正常",
        "1|空内容标记 [[]]\n2|正常",
        "1|\n2|空正文",
        "1|中间空行\n\n3|第三行",
    ],
)
def test_import_rejects_bad_inputs(text):
    r = import_text(text)
    assert r.status_code == 422
    assert r.json()["detail"]["errors"]


def test_line_count_limit():
    text = "\n".join(f"{i}|条款{i}" for i in range(1, 42))  # 41 行
    r = import_text(text)
    assert r.status_code == 422


def test_preview_and_reorder_keeps_binding():
    d = import_text(GOOD).json()
    ids = [c["id"] for c in d["clauses"]]
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]

    # 把原第 4 条移到第 1 位：原第 3 条引用 [[4]] 应显示为 [[1]]，而不是转指新占 4 号位的条款
    order = ["c4", "c1", "c2", "c3"]
    r = client.post("/api/preview", json={"order_ids": order, "clauses": bodies})
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c3"]["text"].startswith("争议解决见 [[1]]，违约参照 [[3]]")
    assert items["c4"]["display"] == 1


def test_edit_save_binds_by_current_display_number():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    # 当前顺序 c4,c1,c2,c3 下，第 1 位是原 4 条
    order = ["c4", "c1", "c2", "c3"]
    r = client.post(
        "/api/save",
        json={
            "order_ids": order,
            "clauses": bodies,
            "edit_id": "c2",
            "text": "改为引用当前第 1 条 [[1]]",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["body"] == "改为引用当前第 1 条 [[c4]]"

    # 再重排：引用仍锁定 c4（原条款），不会转指占旧号的条款
    saved = [b for b in bodies if b["id"] != "c2"] + [{"id": "c2", "body": "改为引用当前第 1 条 [[c4]]"}]
    r = client.post(
        "/api/preview",
        json={"order_ids": ["c1", "c2", "c3", "c4"], "clauses": saved},
    )
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c2"]["text"] == "改为引用当前第 1 条 [[4]]"


def test_save_rejects_dangling_ref():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    r = client.post(
        "/api/save",
        json={"order_ids": ids4(), "clauses": bodies, "edit_id": "c2", "text": "引用不存在 [[5]]"},
    )
    assert r.status_code == 422


def ids4():
    return ["c1", "c2", "c3", "c4"]


def test_delete_referenced_clause_marks_broken_and_blocks_export():
    d = import_text(GOOD).json()
    # 删除被引用的 c4（c3 引用它）
    order = ["c1", "c2", "c3"]
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"] if c["id"] != "c4"]

    r = client.post("/api/preview", json={"order_ids": order, "clauses": bodies})
    preview = r.json()
    assert preview["has_broken"] is True
    c3 = next(it for it in preview["items"] if it["id"] == "c3")
    assert "[[原4?]]" in c3["text"]
    assert c3["broken"] == [{"ref_id": "c4", "original": 4}]

    # 修复前导出 409
    r = client.post("/api/export", json={"order_ids": order, "clauses": bodies})
    assert r.status_code == 409

    # 修复：编辑 c3，改引当前第 1 条（c1）
    r = client.post(
        "/api/save",
        json={"order_ids": order, "clauses": bodies, "edit_id": "c3", "text": "争议解决改为 [[1]]"},
    )
    assert r.status_code == 200
    fixed = [{"id": b["id"], "body": b["body"]} for b in bodies if b["id"] != "c3"]
    fixed.append({"id": "c3", "body": r.json()["body"]})

    r = client.post("/api/preview", json={"order_ids": order, "clauses": fixed})
    assert r.json()["has_broken"] is False

    r = client.post("/api/export", json={"order_ids": order, "clauses": fixed})
    assert r.status_code == 200
    lines = r.json()["text"].split("\n")
    assert lines == [
        "1|甲方在七日内交付设备",
        "2|乙方按 [[1]] 验收后付款",
        "3|争议解决改为 [[1]]",
    ]


def test_self_reference_is_allowed():
    r = import_text("1|本条说明自身 [[1]]\n2|普通条款")
    assert r.status_code == 200


def test_single_line_only_enforced_on_edit():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    r = client.post(
        "/api/save",
        json={"order_ids": ids4(), "clauses": bodies, "edit_id": "c2", "text": "第一行\n第二行"},
    )
    assert r.status_code == 422
    assert "单行" in r.json()["detail"]["errors"][0]


def test_pipe_only_split_on_first_one():
    r = import_text("1|正文里|可以有竖线\n2|引用 [[1]]")
    assert r.status_code == 200
    assert r.json()["clauses"][0]["body"] == "正文里|可以有竖线"


# --------------------------------------------------------------------------- #
# 合并两条条款
# --------------------------------------------------------------------------- #
def merge(bodies, order, picks):
    return client.post(
        "/api/merge", json={"order_ids": order, "clauses": bodies, "pick_ids": picks}
    )


def test_merge_joins_bodies_and_retargets_all_refs():
    # c3 引用 c4 与 c2；合并 c1（第1位）与 c3（第3位）
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]

    r = merge(bodies, ids4(), ["c1", "c3"])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["removed_id"] == "c3"
    assert data["merged_id"] == "c1"
    assert data["order_ids"] == ["c1", "c2", "c4"]

    out = {c["id"]: c["body"] for c in data["clauses"]}
    assert set(out) == {"c1", "c2", "c4"}
    # 两条正文按显示顺序用全角分号连接，c3 内部对 c4/c2 的引用原样保留
    assert out["c1"] == "甲方在七日内交付设备；争议解决见 [[c4]]，违约参照 [[c2]]"
    # c2 原引 c1，仍指合并结果 c1（未变）
    assert out["c2"] == "乙方按 [[c1]] 验收后付款"
    assert out["c4"] == "争议提交仲裁"

    # 预览/导出立即对应同一份草稿，引用编号连续重排
    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    items = {it["id"]: it for it in r.json()["items"]}
    assert r.json()["has_broken"] is False
    assert items["c1"]["display"] == 1
    assert items["c1"]["text"] == "甲方在七日内交付设备；争议解决见 [[3]]，违约参照 [[2]]"
    assert items["c2"]["display"] == 2
    assert items["c2"]["text"] == "乙方按 [[1]] 验收后付款"
    assert items["c4"]["display"] == 3

    r = client.post("/api/export", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.status_code == 200
    assert r.json()["text"].split("\n") == [
        "1|甲方在七日内交付设备；争议解决见 [[3]]，违约参照 [[2]]",
        "2|乙方按 [[1]] 验收后付款",
        "3|争议提交仲裁",
    ]


def test_merge_order_by_display_position_not_pick_order():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    # 选择顺序颠倒，仍按显示位置：c1 前、c3 后，结果占 c1 位置
    r = merge(bodies, ["c4", "c1", "c2", "c3"], ["c3", "c1"])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["merged_id"] == "c1"
    assert data["removed_id"] == "c3"
    assert data["order_ids"] == ["c4", "c1", "c2"]
    out = {c["id"]: c["body"] for c in data["clauses"]}
    assert out["c1"].endswith("；争议解决见 [[c4]]，违约参照 [[c2]]")
    assert out["c1"].startswith("甲方在七日内交付设备；")


def test_merge_redirects_refs_to_later_clause_including_self_refs():
    text = "\n".join(
        [
            "1|甲条款见 [[2]]，并说明自身 [[1]]",  # c1 -> c2, c1
            "2|乙条款自指 [[2]]，另见 [[1]]",        # c2 -> c2, c1
            "3|丙条款引用 [[2]]",                    # c3 -> c2
        ]
    )
    d = import_text(text).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]

    r = merge(bodies, ["c1", "c2", "c3"], ["c1", "c2"])
    assert r.status_code == 200, r.text
    data = r.json()
    out = {c["id"]: c["body"] for c in data["clauses"]}
    # c2 正文中的 [[c2]] 自指与 c1 正文中的 [[c2]] 都改指合并结果 c1
    assert out["c1"] == "甲条款见 [[c1]]，并说明自身 [[c1]]；乙条款自指 [[c1]]，另见 [[c1]]"
    # 其他条款中指向较后者（c2）的引用也改指 c1
    assert out["c3"] == "丙条款引用 [[c1]]"

    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.json()["has_broken"] is False
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c3"]["text"] == "丙条款引用 [[1]]"
    assert "[[1]]" in items["c1"]["text"]
    assert "[[2]]" not in items["c1"]["text"]


def test_merge_keeps_preexisting_broken_refs_broken():
    # 先删除 c4，使 c3 中对 c4 的引用失效；再合并 c2 与 c3（c2 在前）
    d = import_text(GOOD).json()
    order = ["c1", "c2", "c3"]
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"] if c["id"] != "c4"]

    r = merge(bodies, order, ["c2", "c3"])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["order_ids"] == ["c1", "c2"]
    out = {c["id"]: c["body"] for c in data["clauses"]}
    # 合并前已失效的 [[c4]] 原样保留；c3 对 c2 的引用改指合并结果 c2
    assert out["c2"] == "乙方按 [[c1]] 验收后付款；争议解决见 [[c4]]，违约参照 [[c2]]"

    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    preview = r.json()
    assert preview["has_broken"] is True
    c2 = next(it for it in preview["items"] if it["id"] == "c2")
    assert "[[原4?]]" in c2["text"]

    # 存在失效引用时导出仍 409
    r = client.post("/api/export", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.status_code == 409


@pytest.mark.parametrize(
    "picks",
    [
        ["c1"],                       # 只选一条
        ["c1", "c2", "c3"],           # 选了三条
        [],                           # 未选
        ["c1", "c1"],                 # 同一条选两次
        ["c1", "c9"],                 # 不存在的条款
        ["c9", "c8"],                 # 均不存在
    ],
)
def test_merge_rejects_invalid_picks(picks):
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    r = merge(bodies, ids4(), picks)
    assert r.status_code == 422
    assert r.json()["detail"]["errors"]


def test_merge_does_not_touch_other_refs_and_reorder_still_stable():
    # 合并后继续重排，引用不会转指占用旧号码的条款
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    r = merge(bodies, ids4(), ["c1", "c2"])
    data = r.json()
    # c1(合并结果) 内含原 c2 对 c1 的引用；c3 引 c4、c2(→c1)
    out = {c["id"]: c["body"] for c in data["clauses"]}
    assert out["c1"] == "甲方在七日内交付设备；乙方按 [[c1]] 验收后付款"
    assert out["c3"] == "争议解决见 [[c4]]，违约参照 [[c1]]"

    # 把合并结果 c1 移到末位
    order = ["c3", "c4", "c1"]
    r = client.post("/api/preview", json={"order_ids": order, "clauses": data["clauses"]})
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c1"]["text"] == "甲方在七日内交付设备；乙方按 [[3]] 验收后付款"
    assert items["c3"]["text"] == "争议解决见 [[2]]，违约参照 [[3]]"
