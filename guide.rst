PyMi Exercises
==============

Lớp học Python3, nếu máy bạn có cả 2 phiên bản, khi chạy lệnh ``python ...``
dùng ``python3`` thay vì ``python`` để tránh dùng nhầm Python2. (Trên Windows
thường không cài sẵn python nên có thể gõ `python`, `python3`, hay `py` cái nào được thì dùng,
chú ý có thể phải setup PATH, xem hướng dẫn ở đây
https://docs.python.org/3/tutorial/interpreter.html#invoking-the-interpreter)

Quy tắc chung
-------------

- Không chụp ảnh màn hình khi gặp vấn đề nếu có thể copy/paste text.
- NHƯNG NÊN chụp ảnh màn hình nếu không copy/paste được
- Chúng tôi luôn hướng dẫn, chứ không bao giờ LÀM HỘ.

Hướng dẫn dùng câu lệnh trên *NIX (ubuntu, MacOS, ...)
------------------------------------------------------

- https://www.familug.org/2010/06/cmdcac-lenh-ve-thu-muc-va-tap-tin.html

**Chú ý các câu lệnh trong guide này đều gõ trên Ubuntu/Mac OSX [Terminal](http://www.familug.org/2012/03/ccgu-cli-can-ban.html#more) hoặc
trên Windows bật PowerShell lên rồi gõ luôn, KHÔNG PHẢI bật Python lên rồi gõ.**

Hướng dẫn làm bài tập
---------------------

Tất cả bài tập phải làm vào trong thư mục [exercises](https://thegit.pymi.vn/pyfml/pyfml/tree/master/exercises), sửa trực tiếp nội dung của các file ``.py`` đã có tương ứng với bài tập cần làm.
Học xong chương 3 thì làm bài 'ex3_*.py' như ex3_1.py, ex3_2.py ...

Riêng ``ex35_*.py`` là bài làm thêm cho học viên từ buổi 3 đến
buổi 5. Khuyến khích dùng list comprehension.

Học viên không nên CỐ HIỂU toàn bộ các phần trong 1 bài tập ngay từ đầu, hay
ý nghĩa các câu lệnh git,
chỉ cần tập trung vào yêu cầu của đề. Mỗi bài tập đều là 1 chương trình hoàn
chỉnh, học hết bài số 7 mới có thể hiểu hết.

Editor
^^^^^^

Cài đặt editor để mở code, sửa code, lưu code, xem tại `đây <https://gitlab.com/pyfml/prepare#c%C3%A0i-%C4%91%E1%BA%B7t-editor-sau-bu%E1%BB%95i-2->`_

Để chạy code, lớp sẽ dùng dòng lệnh (học viên tuỳ ý làm theo cách của mình và tự giải quyết nếu có vấn đề gì xảy ra).

Cách xử lý "lỗi"
^^^^^^^^^^^^^^^^

Khi chạy lệnh không thành công, vui lòng cung cấp đầy đủ câu lệnh và output,
không chỉ nói "lỗi":

  ```
  codehere nhớ là đã xuống dòng sau 3 dấu ` - dấu này là dấu backtick cạnh số 1, không phải single quote
  ```

Nếu code quá dài, paste code vào đây https://glot.io/

Không nên mất quá nhiều thời gian vào một khó khăn gì, nếu tự xử lý mà sau
TỐI ĐA 2 giờ đồng hồ không xong thì nên lên channel của lớp để hỏi.

**Hạn chế tối đa việc chụp ảnh màn hình và up ảnh nếu không thực sự cần thiết**

Video hướng dẫn
^^^^^^^^^^^^^^^
Nhớ đọc tiếp hướng dẫn phía dưới.

.. image:: https://asciinema.org/a/lzCZfyIQTgsh4cb1gnQSO2PkN.svg
   :width: 400
   :target: https://asciinema.org/a/lzCZfyIQTgsh4cb1gnQSO2PkN

Lấy code về máy
^^^^^^^^^^^^^^^^

Trong thư mục tên pyfml tại ngay thư mục ta gõ lệnh::


  $ ls pyfml/
  01_lecture.rst          gittree.png
  02_lecture.rst          guide.rst
  03_lecture.rst          index.rst

  $ cd pyfml
  ...


**Mọi lệnh bắt đầu bằng chữ `git` (trừ git clone) phải chạy trong thư mục đã
clone mới có tác dụng.**

Chạy 2 lệnh sau (chỉ cần làm 1 lần duy nhất) để cấu hình git::

  git config user.email hvn@familug.org # thay email của bạn vào
  git config user.name 'Viet Hung Nguyen' # thay tên của bạn vào

Các bước nộp bài
^^^^^^^^^^^^^^^^

**MỖI LẦN** làm bài tập (sau mỗi buổi học)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Bước 1
^^^^^^

Vào thư mục ``pyfml``, kiểm tra branch::

  cd pyfml # chuyển đến pyfml
  git branch

Kết quả::

  * master

Nếu không thấy kết quả có ``* master``, hãy chuyển sang branch master trước::

  git checkout master

Lấy phiên bản mới nhất của branch master từ GitLab về máy::

  git pull origin master

Tạo branch mới để nộp bài::

  git checkout -b pymi_XXYYZZ_YOURNAME_lesson

Ví dụ học viên khoá 1704 Hà Nội, tên HungNV, nộp bài 3::

  git checkout -b pymi_1704HN_hungnv_bai3

**Branch này sẽ chứa tất cả bài tập của bài học đó (ở ví dụ này là bài 3),
chỉ tạo duy nhất 1 branch cho một bài học**.

Bước 2
^^^^^^

Sau đó làm bài tập và lưu vào git như sau:

CHÚ Ý: các dòng lệnh bắt đầu với # là ghi chú, không gõ lại.

Di chuyển vào thư mục chứa bài tập::

  # trong pyfml
  cd exercises

Ví dụ làm bài 3.0 sẽ sửa file `ex3_0.py` bằng editor đã cài.

Nội dung của file này chứa đề bài và lời giải của bài toán.
Học viên sửa nội dung trong function solve() để trả về kết quả
phù hợp, đặt `result` bằng giá trị cần tìm. Không sửa đề bài, không sửa hàm
main, không return giá trị khác `result`.

Và chạy file này với lệnh::

  # trong exercises
  python3 ex3_0.py  # Trên Windows, gõ py ex3_0.py hay python ex3_0.py cái nào được thì dùng.

Học viên kiểm tra code viết đúng chuẩn chưa::

  # trong exercises
  python3 ../vendor/pep8.py ex3_0.py

Nếu thấy không in ra gì tức code đã đúng chuẩn Python (PEP8) rồi 🏆

Học viên chạy lệnh sau (gõ y hệt, không cần sửa gì) tại thư mục `pyfml` để kiểm tra xem bài làm mình đã đúng
chưa (chú ý, thư mục `pyfml`, không phải `exercises`, và chắc chắn là bạn đang
dùng Python 3, không phải Python 2)::

  # trong exercises
  cd .. # chuyển tới thư mục pyfml từ exercises
  python3 -m unittest tests.test_ex3 -vvv

kiểm tra bài buổi 4 thì thay số 3 bằng số 4, bài 35 thì thay số 3 bằng 35 ...

hoặc lệnh sau nếu bạn thấy kết quả tương tự::

  # trong pyfml
  python3 setup.py test --test-suite tests.test_ex3

Nếu đúng, output sẽ trông như sau::

  test_ex3_0 (test_ex3.TestExercise3) ... ok

Nếu có exception xảy ra hay chưa làm, kết quả sẽ như sau::

  test_ex3_0 (test_ex3.TestExercise3) ... ERROR

Nếu sai, kết quả sẽ như sau::

  test_ex3_0 (test_ex3.TestExercise3) ... FAIL

Hãy đọc chi tiết của phần output sau khi chạy câu lệnh để xem lỗi/sai gì. Kết quả khá dài, vì đây là test của tất cả các bài tập, tìm những gì mình đang làm.
Không cần quan tâm đến các bài mình chưa học.

Làm bài xong học viên lưu vào git (nhớ vào thư mục `exercises` trước khi chạy)::

  git status  # xem có gì đã thay đổi
  git add ex3_0.py
  git commit -sm 'add - HAY NỘI DUNG TÙY Ý (e.g FIX BUG XYZ)'

Chú ý: không dùng `git add .` do nó sẽ add các file không cần thiết / nhạy cảm

Bước 3
^^^^^^

Push (đẩy) bài tập lên trang GitLab::

  git push origin YOUR_BRANCH  # CHÚ Ý, phải dùng đúng tên branch của bạn, như ví dụ này là thay YOUR_BRANCH bằng pymi_1704HN_hungnv_bai3

Nếu thấy thông báo như sau là đã thành công::

  ...
  Counting objects: 2, done.
  Delta compression using up to 8 threads.
  Compressing objects: 100% (2/2), done.
  Writing objects: 100% (2/2), 234 bytes | 0 bytes/s, done.
  Total 2 (delta 1), reused 0 (delta 0)
  remote:
  remote: To create a merge request for hvn_123, visit:
  remote:   https://thegit.pymi.vn/pyfml/pyfml/merge_requests/new?merge_request%5Bsource_branch%5D=hvn_123
  ...
   * [new branch]      hvn_123 -> hvn_123

Tiếp tục làm các bài tập khác, rồi add, commit, push, tới khi làm hết.

Test riêng một bài
-------------------

Từ thư mục ``pyfml``, chạy::

  $ python -m unittest tests.test_ex4.TestExercise4.test_ex4_9
  E
  ======================================================================
  ERROR: test_ex4_9 (tests.test_ex4.TestExercise4)
  ----------------------------------------------------------------------
  Traceback (most recent call last):
    File "/home/hvn/me/pyfml/tests/test_ex4.py", line 207, in test_ex4_9
      self._test_all(ex4_9.solve, cases)
    File "/home/hvn/me/pyfml/tests/base.py", line 9, in _test_all
      output = func(input)
    File "/home/hvn/me/pyfml/exercises/ex4_9.py", line 12, in solve
      raise NotImplementedError("Học viên chưa làm bài này")
  NotImplementedError: Học viên chưa làm bài này

  ----------------------------------------------------------------------
  Ran 1 test in 0.000s


Debug 1 chương trình
--------------------

Thay vì chạy file python bình thường với câu lệnh::

  python filename.py

Chạy bằng câu lệnh sau để vào chế độ "debug"::

  python -m pdb filename.py

Ở đây:

- bấm ``n`` để chạy sang dòng tiếp theo (n = next)
- bấm ``l`` để hiện xem code đang ở đâu (l = list)
- gõ ``p NAME`` để in ra nội dung của tên ``NAME`` (p = print).
- gõ ``exit`` để thoát.

Ví dụ::

  $ python -m pdb foo.py
  > /home/hvn/foo.py(2)<module>()
  -> s = {"tao": 20,
  (Pdb) n
  > /home/hvn/foo.py(3)<module>()
  -> "Duy": 30,
  (Pdb) l
    1
    2  	s = {"tao": 20,
    3  ->	        "Duy": 30,
    4  	        }
    5
    6  	import logging
    7
    8  	logging.basicConfig(level=logging.DEBUG, filename='my.log')
    9  	logger = logging.getLogger('foo')
   10  	sum_  = 0
   11  	for i in ["tao", "Duy"]:
  (Pdb) n
  > /home/hvn/foo.py(6)<module>()
  -> import logging
  (Pdb) p s
  {'tao': 20, 'Duy': 30}
  (Pdb) exit


Bài tập làm thêm
-----------------

- Học viên PyMi yêu cầu làm tối thiểu 25 bài ProjectEuler https://projecteuler.net/
  trước khi kết thúc khóa học. Phục vụ mục đích phỏng vấn vào các công ty.
- HackerRank https://www.hackerrank.com/domains/python/py-introduction
  Học viên nên làm trên 500 điểm - phục vụ mục đích phỏng vấn vào các công ty.
- LeetCode https://leetcode.com/problemset/all/
  Học viên làm một vài Problem để làm quen, LeetCode là trang luyện thuật toán
  phỏng vấn được sử dụng phổ biến trên toàn cầu - có kèm cả lời giải.
- Làm thêm nếu thích: 99 Problems https://wiki.python.org/moin/ProblemSets/99%20Prolog%20Problems%20Solutions
- Làm thêm nếu thích: Python koans https://github.com/gregmalcolm/python_koans

Books, articles
===============

https://www.familug.org/2016/12/free-ebook.html

diveinpython
------------

http://www.diveintopython3.net/table-of-contents.html

Hitchhiker
----------

http://docs.python-guide.org/en/latest/

SO path
-------

http://stackoverflow.com/questions/2573135/python-progression-path-from-apprentice-to-guru?rq=1

antipatterns
------------

http://docs.quantifiedcode.com/python-code-patterns/

slot
----

https://github.com/python-diamond/Diamond/pull/256/files

become programmer
-----------------

http://norvig.com/21-days.html

become hacker
-------------

http://www.catb.org/esr/faqs/hacker-howto.html

write review on facebook
------------------------

https://www.facebook.com/pyfml/reviews

Interview questions
-------------------

- https://faq.pymi.vn/
- https://www.toptal.com/python#hiring-guide
- https://docs.python.org/3/faq/programming.html
