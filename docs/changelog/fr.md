Notes de version : V1.2.0-Alpha-V1

Principaux changements

Cette version est une version d'aperçu. Merci à celles et ceux qui installent et utilisent le plugin, et merci de votre patience au fil des versions ; les signalements de bugs et les suggestions sont les bienvenus.

- Dix langues dans l'interface, dont huit nouvelles
- Le plugin a été restructuré, le démarrage à froid est bien plus rapide
- La liste ne se rafraîchissait pas toujours après une suppression ; corrigé
- Sans runtime, le téléchargement est maintenant proposé
- Le dossier de données peut revenir à son emplacement par défaut
- Tous les dialogues passent par ceux de DSH

Le détail des changements

Nouveautés

- Huit nouvelles langues, dix au total (japonais, coréen, allemand, français, espagnol, russe, portugais, chinois traditionnel)
- Barre de progression des résumés IA
- Sans composant Electron, le téléchargement est proposé directement
- Réglages › Dossier de données : changer d'emplacement, revenir à l'emplacement par défaut
- Les notes de version sont traduites elles aussi

Améliorations

- Démarrage à froid 3,1 s → 0,12 s (deux mille sessions) ; le redémarrage lit le manifeste des sessions
- Le rafraîchissement ne lit que les fichiers modifiés ; une réponse n'entraîne plus un balayage complet
- Les longues listes ne créent que les lignes visibles ; le premier écran économise plus de cinquante mille éléments
- En-tête de session et statistiques mis en cache par version de fichier
- L'indexation rend la main tous les 150 ms et borne le texte d'une session
- Le survol est mis en évidence immédiatement
- Vider le cache couvre deux entrées de plus : manifeste des sessions et index du contenu
- Les dialogues utilisent ceux de DSH
- Quelques formulations revues

Corrections

- Suppression de sessions : les sessions ouvertes partent aussi à la corbeille, ne tombent plus dans « Non classé » et ne laissent pas de dossier vide
- Le panneau restait parfois vide
- Une session supprimée restait dans l'espace de travail
- La fenêtre du gestionnaire de fichiers retenait le processus DSH
- Les marges du menu de ligne ne suivaient pas celles du menu hôte
- Le runtime s'affichait sous le nom Electron
- La progression du téléchargement du composant démarre maintenant au clic
