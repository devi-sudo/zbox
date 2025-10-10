    
        // Particles.js config
        document.addEventListener('DOMContentLoaded', function() {
            particlesJS('particles-js', {
                particles: {
                    number: { value: 80, density: { enable: true, value_area: 800 } },
                    color: { value: "#ff0080" },
                    shape: { type: "circle" },
                    opacity: { value: 0.5, random: true },
                    size: { value: 3, random: true },
                    line_linked: {
                        enable: true,
                        distance: 150,
                        color: "#7928ca",
                        opacity: 0.4,
                        width: 1
                    },
                    move: {
                        enable: true,
                        speed: 2,
                        direction: "none",
                        random: true,
                        straight: false,
                        out_mode: "out",
                        bounce: false
                    }
                },
                interactivity: {
                    detect_on: "canvas",
                    events: {
                        onhover: { enable: true, mode: "grab" },
                        onclick: { enable: true, mode: "push" },
                        resize: true
                    }
                },
                retina_detect: true
            });
        });

        let selectedPlan = '';

        function selectPlan(plan) {
            selectedPlan = plan;
            const modal = document.getElementById('paymentModal');
            const title = document.getElementById('modalTitle');
            
            const planNames = {
                'rush': '24/7 Rush Plan ($15/5 days)',
                'weekly': 'Weekly Pro ($25/7 days)',
                'monthly': 'Monthly Elite ($45/30 days)',
                'quarterly': 'Quarterly VIP ($99/90 days)'
            };
            
            title.textContent = `Payment - ${planNames[plan]}`;
            modal.classList.remove('hidden');
        }

        function closeModal() {
            document.getElementById('paymentModal').classList.add('hidden');
        }

        function processPayment(method) {
            const planPrices = {
                'rush': 15,
                'weekly': 25,
                'monthly': 45,
                'quarterly': 99
            };

            const price = planPrices[selectedPlan];
            alert(`Redirecting to ${method.toUpperCase()} payment for $${price}...\n\nAfter payment, contact @zboxsupport with your transaction ID to activate your premium access.`);
            closeModal();
        }

        // Close modal when clicking outside
        document.getElementById('paymentModal').addEventListener('click', function(e) {
            if (e.target.id === 'paymentModal') {
                closeModal();
            }
        });
    
