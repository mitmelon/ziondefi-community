var general = new General;

$(window).on('load', function () {
   
     const views = {
        login: document.getElementById('view-login'),
        onboarding: document.getElementById('view-onboarding'),
        dashboard: document.getElementById('view-dashboard')
    };
    const modal = document.getElementById('modal-overlay');
    const modalContent = document.getElementById('modal-content');
    const navBtn = document.getElementById('nav-wallet-btn');

    function switchView(viewName) {
        Object.values(views).forEach(v => v.classList.add('hidden'));
        views[viewName].classList.remove('hidden');
    }


    $(document).on("submit", ".connect", function (e) {
        e.preventDefault();
        var formData = new FormData(this);
        var button = $('#signin-btn').html();
        formData.append('fingerprint', radar._Fingerprint());
        formData.append('requestUrl', general.getCurrentUrl());
        general.ajaxFormData('.authenticate', 'POST', '/login', formData, '#signin-btn', button, function (data) {
            if (data.status === 200) {
                $('#signin-btn').attr('disabled', true);
                $('#signin-btn').attr('style', 'opacity: 0.5');
                document.querySelector('#signin-btn').style.pointerEvents = "none";
                $('#signin-btn').html('Redirecting...');
                setTimeout(() => {
                    if(general.getCurrentUrl().includes('/logout')) {
                        general.redirect('/home');
                    } else {
                        general.reload();
                    }
                }, 3000);
            }
        }, 'centerLoader');
    });
    //


})